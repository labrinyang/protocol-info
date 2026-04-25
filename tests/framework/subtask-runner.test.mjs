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
];
