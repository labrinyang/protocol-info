import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveR2Routing, runR2Reconcile } from '../../framework/r2-runner.mjs';

async function writeFixture(dir, {
  webPrompt = 'WEB {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
  evidencePrompt = 'EVIDENCE {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
  maxResearchRounds = 2,
} = {}) {
  const manifestPath = join(dir, 'manifest.json');
  const schemaPath = join(dir, 'full.json');
  const webPromptPath = join(dir, 'reconcile.md');
  const evidencePromptPath = join(dir, 'reconcile.evidence.md');
  await writeFile(schemaPath, JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['slug'],
    properties: {
      slug: { type: 'string' },
      establishment: { type: 'integer' },
    },
  }));
  await writeFile(webPromptPath, webPrompt);
  await writeFile(evidencePromptPath, evidencePrompt);
  await writeFile(manifestPath, JSON.stringify({
    name: 'test',
    version: '1.0.0',
    schemas: { full: './full.json' },
    reconcile: {
      enabled: true,
      prompt: './reconcile.md',
      evidence_prompt: './reconcile.evidence.md',
      max_turns: 1,
      max_budget_usd: 0.01,
      max_research_rounds: maxResearchRounds,
      max_search_queries_per_round: 4,
    },
    fetchers: [],
    subtasks: [],
  }));
  return manifestPath;
}

export const tests = [
  {
    name: 'resolveR2Routing normalizes aliases and rejects unknown modes',
    fn: async () => {
      assert.equal(resolveR2Routing({ routing: 'single-provider' }), 'single_provider');
      assert.equal(resolveR2Routing({ routing: 'external-first' }), 'external_first');
      assert.equal(
        resolveR2Routing({ routing: 'external-first-with-claude-fallback' }),
        'external_first_with_claude_fallback',
      );
      assert.throws(
        () => resolveR2Routing({ routing: 'external_frist' }),
        (err) => err.kind === 'arg_invalid' && /unsupported R2 routing/.test(err.message),
      );
    },
  },
  {
    name: 'runR2Reconcile runs search_requests loop and writes enriched evidence',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'r2-runner-search-'));
      try {
        const manifestPath = await writeFixture(dir);
        const recordIn = join(dir, 'record.json');
        const findingsIn = join(dir, 'findings.json');
        const gapsIn = join(dir, 'gaps.json');
        const evidencePath = join(dir, 'evidence.json');
        const recordOut = join(dir, 'record.r2.json');
        const debugDir = join(dir, 'debug');
        await writeFile(recordIn, JSON.stringify({ slug: 'pendle' }));
        await writeFile(findingsIn, '[]');
        await writeFile(gapsIn, '[]');
        await writeFile(evidencePath, JSON.stringify({ rootdata: { anchors: { slug: 'pendle' } } }));

        const prompts = [];
        const result = await runR2Reconcile({
          manifestPath,
          recordIn,
          findingsIn,
          gapsIn,
          evidencePath,
          recordOut,
          debugDir,
          runSubtask: async (args) => {
            prompts.push(args.userPrompt);
            if (prompts.length === 1) {
              return {
                ok: true,
                slice: { slug: 'pendle' },
                findings: [],
                changes: [],
                gaps: [],
                search_requests: [
                  { channel: 'rootdata', type: 'project', query: 'Pendle', reason: 'verify project' },
                ],
                cost_usd: 0,
                turns: 1,
                envelope: { total_cost_usd: 0, num_turns: 1, structured_output: {} },
              };
            }
            assert.match(args.userPrompt, /search_results/);
            assert.match(args.userPrompt, /RootData Pendle/);
            return {
              ok: true,
              slice: { slug: 'pendle' },
              findings: [],
              changes: [],
              gaps: [],
              search_requests: [],
              cost_usd: 0,
              turns: 1,
              envelope: { total_cost_usd: 0, num_turns: 1, structured_output: {} },
            };
          },
          runSearchRequests: async ({ requests }) => {
            assert.equal(requests[0].query, 'Pendle');
            return [
              { channel: 'rootdata', query: 'Pendle', ok: true, results: [{ name: 'RootData Pendle' }] },
            ];
          },
        });

        assert.equal(result.ok, true);
        assert.equal(prompts.length, 2);
        const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
        assert.equal(evidence.search_results[0].results[0].name, 'RootData Pendle');
        assert.equal(JSON.parse(await readFile(recordOut, 'utf8')).slug, 'pendle');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'runR2Reconcile applies mergeR2 high-confidence suppression',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'r2-runner-guard-'));
      try {
        const manifestPath = await writeFixture(dir, { maxResearchRounds: 1 });
        const recordIn = join(dir, 'record.json');
        const findingsIn = join(dir, 'findings.json');
        const gapsIn = join(dir, 'gaps.json');
        const recordOut = join(dir, 'record.r2.json');
        const gapsOut = join(dir, 'gaps.r2.json');
        const debugDir = join(dir, 'debug');
        await writeFile(recordIn, JSON.stringify({ slug: 'pendle', establishment: 2020 }));
        await writeFile(findingsIn, JSON.stringify([{ field: 'establishment', confidence: 0.95, source: 'https://example.com' }]));
        await writeFile(gapsIn, '[]');

        const result = await runR2Reconcile({
          manifestPath,
          recordIn,
          findingsIn,
          gapsIn,
          recordOut,
          gapsOut,
          debugDir,
          runSubtask: async () => ({
            ok: true,
            slice: { slug: 'pendle', establishment: 2021 },
            findings: [],
            changes: [],
            gaps: [],
            search_requests: [],
            cost_usd: 0,
            turns: 1,
            envelope: { total_cost_usd: 0, num_turns: 1, structured_output: {} },
          }),
        });

        assert.equal(result.ok, true);
        assert.equal(JSON.parse(await readFile(recordOut, 'utf8')).establishment, 2020);
        assert.match(await readFile(gapsOut, 'utf8'), /r2_uncited_high_conf_change_suppressed/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'external-first R2 uses evidence prompt and falls back to Claude web prompt when gate rejects',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'r2-runner-external-'));
      try {
        const manifestPath = await writeFixture(dir, {
          webPrompt: 'WEB_PROMPT {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
          evidencePrompt: 'EVIDENCE_ONLY_PROMPT {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
          maxResearchRounds: 1,
        });
        const recordIn = join(dir, 'record.json');
        const findingsIn = join(dir, 'findings.json');
        const gapsIn = join(dir, 'gaps.json');
        const recordOut = join(dir, 'record.r2.json');
        const debugDir = join(dir, 'debug');
        await writeFile(recordIn, JSON.stringify({ slug: 'pendle', establishment: 2020 }));
        await writeFile(findingsIn, JSON.stringify([{ field: 'establishment', confidence: 0.95, source: 'https://example.com' }]));
        await writeFile(gapsIn, '[]');

        const calls = [];
        const result = await runR2Reconcile({
          manifestPath,
          recordIn,
          findingsIn,
          gapsIn,
          recordOut,
          debugDir,
          routing: 'external_first_with_claude_fallback',
          env: { OPENAI_API_KEY: 'test', OPENAI_MODEL: 'gpt-test' },
          runSubtask: async (args) => {
            calls.push({ provider: args.llmProvider, prompt: args.userPrompt });
            if (args.llmProvider === 'openai') {
              assert.match(args.userPrompt, /EVIDENCE_ONLY_PROMPT/);
              return {
                ok: true,
                slice: { slug: 'pendle', establishment: 2021 },
                findings: [],
                changes: [],
                gaps: [],
                search_requests: [],
                cost_usd: 0,
                turns: 1,
                envelope: { total_cost_usd: 0, num_turns: 1, structured_output: {} },
              };
            }
            assert.equal(args.llmProvider, 'claude');
            assert.match(args.userPrompt, /WEB_PROMPT/);
            return {
              ok: true,
              slice: { slug: 'pendle', establishment: 2020 },
              findings: [],
              changes: [],
              gaps: [],
              search_requests: [],
              cost_usd: 0,
              turns: 1,
              envelope: { total_cost_usd: 0, num_turns: 1, structured_output: {} },
            };
          },
        });

        assert.equal(result.ok, true);
        assert.equal(result.selected, 'fallback');
        assert.deepEqual(calls.map((c) => c.provider), ['openai', 'claude']);
        assert.equal(JSON.parse(await readFile(recordOut, 'utf8')).establishment, 2020);
        const route = JSON.parse(await readFile(join(debugDir, 'reconcile.route.json'), 'utf8'));
        assert.equal(route.selected, 'fallback');
        assert.match(route.attempts[0].gate.reasons.join('\n'), /merge_guard_gaps/);
        assert.equal(existsSync(join(debugDir, 'reconcile.external.round1.envelope.json')), true);
        assert.equal(existsSync(join(debugDir, 'reconcile.fallback.round1.envelope.json')), true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'external_first rejects gated external result without Claude fallback',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'r2-runner-external-only-'));
      try {
        const manifestPath = await writeFixture(dir, {
          webPrompt: 'WEB_PROMPT {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
          evidencePrompt: 'EVIDENCE_ONLY_PROMPT {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
          maxResearchRounds: 1,
        });
        const recordIn = join(dir, 'record.json');
        const findingsIn = join(dir, 'findings.json');
        const gapsIn = join(dir, 'gaps.json');
        const recordOut = join(dir, 'record.r2.json');
        const debugDir = join(dir, 'debug');
        await writeFile(recordIn, JSON.stringify({ slug: 'pendle', establishment: 2020 }));
        await writeFile(findingsIn, JSON.stringify([{ field: 'establishment', confidence: 0.95, source: 'https://example.com' }]));
        await writeFile(gapsIn, '[]');

        const calls = [];
        const result = await runR2Reconcile({
          manifestPath,
          recordIn,
          findingsIn,
          gapsIn,
          recordOut,
          debugDir,
          routing: 'external_first',
          env: { OPENAI_API_KEY: 'test', OPENAI_MODEL: 'gpt-test' },
          runSubtask: async (args) => {
            calls.push({ provider: args.llmProvider, prompt: args.userPrompt });
            assert.equal(args.llmProvider, 'openai');
            assert.match(args.userPrompt, /EVIDENCE_ONLY_PROMPT/);
            return {
              ok: true,
              slice: { slug: 'pendle', establishment: 2021 },
              findings: [],
              changes: [],
              gaps: [],
              search_requests: [],
              cost_usd: 0,
              turns: 1,
              envelope: { total_cost_usd: 0, num_turns: 1, structured_output: {} },
            };
          },
        });

        assert.equal(result.ok, false);
        assert.equal(result.selected, null);
        assert.deepEqual(calls.map((c) => c.provider), ['openai']);
        assert.equal(existsSync(recordOut), false);
        const route = JSON.parse(await readFile(join(debugDir, 'reconcile.route.json'), 'utf8'));
        assert.equal(route.routing, 'external_first');
        assert.equal(route.selected, null);
        assert.equal(route.attempts.length, 1);
        assert.match(route.attempts[0].gate.reasons.join('\n'), /merge_guard_gaps/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'single-provider OpenAI R2 uses evidence-only prompt semantics',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'r2-runner-openai-prompt-'));
      try {
        const manifestPath = await writeFixture(dir, {
          webPrompt: 'WEB_PROMPT {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
          evidencePrompt: 'EVIDENCE_ONLY_PROMPT {{RECORD}} {{FINDINGS}} {{GAPS}} {{HANDOFF_NOTES}} {{EVIDENCE}} {{SCHEMA}}',
          maxResearchRounds: 1,
        });
        const recordIn = join(dir, 'record.json');
        const findingsIn = join(dir, 'findings.json');
        const gapsIn = join(dir, 'gaps.json');
        const recordOut = join(dir, 'record.r2.json');
        const debugDir = join(dir, 'debug');
        await writeFile(recordIn, JSON.stringify({ slug: 'pendle' }));
        await writeFile(findingsIn, '[]');
        await writeFile(gapsIn, '[]');

        await runR2Reconcile({
          manifestPath,
          recordIn,
          findingsIn,
          gapsIn,
          recordOut,
          debugDir,
          env: { R2_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test', OPENAI_MODEL: 'gpt-test' },
          runSubtask: async (args) => {
            assert.match(args.userPrompt, /EVIDENCE_ONLY_PROMPT/);
            assert.doesNotMatch(args.userPrompt, /WEB_PROMPT/);
            return {
              ok: true,
              slice: { slug: 'pendle' },
              findings: [],
              changes: [],
              gaps: [],
              search_requests: [],
              cost_usd: null,
              turns: 1,
              envelope: { total_cost_usd: null, num_turns: 1, structured_output: {} },
            };
          },
        });

        const route = JSON.parse(await readFile(join(debugDir, 'reconcile.route.json'), 'utf8'));
        assert.equal(route.attempts[0].provider, 'openai');
        assert.equal(route.attempts[0].prompt_mode, 'evidence');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
];
