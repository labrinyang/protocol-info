import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const tests = [
  {
    name: 'r2 exits nonzero and writes no promoted record when first synthesis round fails',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'r2-cli-'));
      try {
        const manifestPath = join(dir, 'manifest.json');
        const schemaPath = join(dir, 'full.json');
        const promptPath = join(dir, 'reconcile.md');
        const recordIn = join(dir, 'record.json');
        const findingsIn = join(dir, 'findings.json');
        const gapsIn = join(dir, 'gaps.json');
        const recordOut = join(dir, 'record.r2.json');
        const debugDir = join(dir, 'debug');
        const claudePath = join(dir, 'claude');

        await writeFile(schemaPath, JSON.stringify({
          type: 'object',
          additionalProperties: true,
          required: ['slug'],
          properties: { slug: { type: 'string' } },
        }));
        await writeFile(promptPath, 'Return JSON for {{RECORD}} {{FINDINGS}} {{GAPS}} {{EVIDENCE}} {{SCHEMA}}');
        await writeFile(manifestPath, JSON.stringify({
          name: 'test',
          version: '1.0.0',
          schemas: { full: './full.json' },
          reconcile: { enabled: true, prompt: './reconcile.md', max_turns: 1, max_budget_usd: 0.01, max_research_rounds: 1 },
          fetchers: [],
          subtasks: [],
        }));
        await writeFile(recordIn, JSON.stringify({ slug: 's' }));
        await writeFile(findingsIn, '[]');
        await writeFile(gapsIn, '[]');
        await writeFile(claudePath, `#!/bin/bash
cat > /dev/null
echo '{"session_id":"s","total_cost_usd":0,"num_turns":0,"result":"no structured output here"}'
`);
        await chmod(claudePath, 0o755);

        const res = spawnSync('node', [
          'framework/cli/r2.mjs',
          '--manifest', manifestPath,
          '--record-in', recordIn,
          '--findings-in', findingsIn,
          '--gaps-in', gapsIn,
          '--record-out', recordOut,
          '--debug-dir', debugDir,
        ], {
          cwd: process.cwd(),
          env: { ...process.env, CLAUDE_BIN: claudePath },
          encoding: 'utf8',
        });

        assert.notEqual(res.status, 0, `expected r2 to fail, stderr=${res.stderr}`);
        assert.equal(existsSync(recordOut), false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
];
