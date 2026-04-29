import { strict as assert } from 'node:assert';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubtask } from '../../framework/subtask-runner.mjs';

async function withStubClaude(stdoutJson, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'st-'));
  const claudePath = join(dir, 'claude');
  await writeFile(claudePath, `#!/bin/bash\ncat > /dev/null\ncat <<'JSON'\n${stdoutJson}\nJSON\n`);
  await chmod(claudePath, 0o755);
  try { return await fn(claudePath); }
  finally { await rm(dir, { recursive: true }); }
}

export const tests = [
  {
    name: 'returns slice + envelope on success',
    fn: async () => {
      const env = JSON.stringify({
        session_id: 's', total_cost_usd: 0.05, num_turns: 3,
        structured_output: { members: [{ memberName: 'A', memberPosition: 'CEO' }] }
      });
      await withStubClaude(env, async (claudeBin) => {
        const result = await runSubtask({
          claudeBin,
          subtask: { name: 'team', max_turns: 10, max_budget_usd: 0.5 },
          systemPrompt: 'sys',
          userPrompt: 'usr',
          schemaSlice: { type: 'object', properties: { members: { type: 'array' } } },
        });
        assert.equal(result.ok, true);
        assert.deepEqual(result.slice, { members: [{ memberName: 'A', memberPosition: 'CEO' }] });
        assert.equal(result.cost_usd, 0.05);
        assert.equal(result.turns, 3);
        assert.equal(result.session_id, 's');
      });
    },
  },
  {
    name: 'returns ok:false with error on parse failure',
    fn: async () => {
      const env = JSON.stringify({ session_id: 's', total_cost_usd: 0.01, num_turns: 1, result: 'no JSON here' });
      await withStubClaude(env, async (claudeBin) => {
        const result = await runSubtask({
          claudeBin,
          subtask: { name: 'team', max_turns: 5, max_budget_usd: 0.5 },
          systemPrompt: '', userPrompt: 'x',
          schemaSlice: { type: 'object' },
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /no.*structured_output|parse/i);
      });
    },
  },
  {
    name: 'returns ok:false with error_kind on claude spawn failure',
    fn: async () => {
      const result = await runSubtask({
        claudeBin: '/nonexistent/claude-binary-for-test',
        subtask: { name: 'team', max_turns: 5, max_budget_usd: 0.5 },
        systemPrompt: '', userPrompt: 'x',
        schemaSlice: { type: 'object' },
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /claude invocation failed/);
      assert.equal(result.session_id, null);
      assert.equal(result.cost_usd, 0);
      assert.equal(result.turns, 0);
      assert.equal(result.envelope, null);
      // error_kind should be 'spawn_error' from claude-wrapper, but allow null fallback
      assert.ok(result.error_kind === 'spawn_error' || result.error_kind === null,
        `expected error_kind to be 'spawn_error' or null, got ${result.error_kind}`);
    },
  },
  {
    name: 'returns slice + findings + gaps + handoff_notes in β-shape',
    fn: async () => {
      const env = JSON.stringify({
        session_id: 's', total_cost_usd: 0.05, num_turns: 3,
        structured_output: {
          slice: { members: [{ memberName: 'A' }] },
          findings: [{ field: 'members[0].memberName', value: 'A', source: 'https://x.com/a', confidence: 0.9 }],
          gaps: [],
          handoff_notes: [{ target: 'funding', note: 'A appears in seed announcement', source: 'https://example.com/seed' }],
        },
      });
      await withStubClaude(env, async (claudeBin) => {
        const result = await runSubtask({
          claudeBin,
          subtask: { name: 'team', max_turns: 5, max_budget_usd: 0.5 },
          systemPrompt: '', userPrompt: 'x',
          schemaSlice: { type: 'object' },
          findingsSchema: { type: 'array' },
          gapsSchema: { type: 'array' },
        });
        assert.equal(result.ok, true);
        assert.deepEqual(result.slice, { members: [{ memberName: 'A' }] });
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].confidence, 0.9);
        assert.deepEqual(result.gaps, []);
        assert.equal(result.handoff_notes.length, 1);
        assert.deepEqual(result.search_requests, []);
        assert.deepEqual(result.changes, []);
      });
    },
  },
  {
    name: 'routes subtask calls through injected structured LLM runner',
    fn: async () => {
      let call = null;
      const result = await runSubtask({
        subtask: { name: 'team', max_turns: 5, max_budget_usd: 0.5 },
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schemaSlice: { type: 'object' },
        findingsSchema: { type: 'array' },
        gapsSchema: { type: 'array' },
        llmProvider: 'openai',
        stage: 'refresh:team',
        runLLM: async (args) => {
          call = args;
          return {
            session_id: 's',
            total_cost_usd: 0,
            num_turns: 1,
            structured_output: {
              slice: { members: [] },
              findings: [],
              gaps: [],
            },
          };
        },
      });

      assert.equal(result.ok, true);
      assert.equal(call.provider, 'openai');
      assert.equal(call.stage, 'refresh:team');
      assert.equal(call.maxTurns, 5);
      assert.equal(call.maxBudgetUsd, 0.5);
    },
  },
  {
    name: 'returns ok:false when β-mode envelope is missing findings',
    fn: async () => {
      const env = JSON.stringify({
        session_id: 's', total_cost_usd: 0.05, num_turns: 3,
        structured_output: { slice: { members: [] } },  // missing findings + gaps
      });
      await withStubClaude(env, async (claudeBin) => {
        const result = await runSubtask({
          claudeBin,
          subtask: { name: 'team', max_turns: 5, max_budget_usd: 0.5 },
          systemPrompt: '', userPrompt: 'x',
          schemaSlice: { type: 'object' },
          findingsSchema: { type: 'array' },
          gapsSchema: { type: 'array' },
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /β output missing/);
      });
    },
  },
];
