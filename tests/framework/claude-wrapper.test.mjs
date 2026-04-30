import { strict as assert } from 'node:assert';
import { writeFile, readFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../../framework/claude-wrapper.mjs';

async function withStub(scriptBody, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stub-'));
  const claudePath = join(dir, 'claude');
  await writeFile(claudePath, `#!/bin/bash\n${scriptBody}\n`);
  await chmod(claudePath, 0o755);
  try {
    return await fn(claudePath);
  } finally {
    await rm(dir, { recursive: true });
  }
}

export const tests = [
  {
    name: 'returns parsed envelope on success',
    fn: async () => {
      await withStub('cat > /dev/null; echo \'{"session_id":"s","total_cost_usd":0.01,"num_turns":1,"structured_output":{"ok":true}}\'', async (claudePath) => {
        const env = await runClaude({
          claudeBin: claudePath,
          systemPrompt: 'sys',
          userPrompt: 'usr',
          schemaJson: { type: 'object' },
          maxTurns: 5,
          maxBudgetUsd: 0.50,
        });
        assert.equal(env.session_id, 's');
        assert.deepEqual(env.structured_output, { ok: true });
      });
    },
  },
  {
    name: 'throws on non-zero exit when stdout is not parseable JSON',
    fn: async () => {
      await withStub('cat > /dev/null; echo "boom" >&2; exit 2', async (claudePath) => {
        await assert.rejects(
          () => runClaude({ claudeBin: claudePath, userPrompt: 'x', schemaJson: {}, maxTurns: 1, maxBudgetUsd: 0.01 }),
          /exit 2/
        );
      });
    },
  },
  {
    name: 'resolves with envelope when claude exits non-zero but stdout is parseable JSON',
    fn: async () => {
      // Claude CLI's `--output-format json` writes API errors (e.g. 400 invalid_request_error,
      // 529 overloaded, max-budget exceeded) into the envelope and exits non-zero. The wrapper
      // must preserve that envelope so downstream code can surface the diagnostic.
      const envJson = '{"type":"result","is_error":true,"result":"API Error: 400 invalid_request_error","total_cost_usd":0,"num_turns":0,"session_id":"s"}';
      await withStub(`cat > /dev/null; echo '${envJson}'; exit 1`, async (claudePath) => {
        const env = await runClaude({
          claudeBin: claudePath,
          userPrompt: 'x',
          schemaJson: {},
          maxTurns: 1,
          maxBudgetUsd: 0.01,
          retryOnTransient: false,
        });
        assert.equal(env.is_error, true);
        assert.equal(env.session_id, 's');
        assert.match(env.result, /400 invalid_request_error/);
      });
    },
  },
  {
    name: 'retries when envelope reports transient error (is_error + 529)',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'claude-tenv-'));
      const counterPath = join(dir, 'count');
      const claudePath = join(dir, 'claude');
      await writeFile(counterPath, '0');
      const script = `#!/bin/bash
cat > /dev/null
n=$(cat ${counterPath})
echo $((n+1)) > ${counterPath}
if [ "$n" = "0" ]; then
  echo '{"type":"result","is_error":true,"result":"API Error: 529 overloaded_error","total_cost_usd":0,"num_turns":0,"session_id":"s"}'
  exit 1
fi
echo '{"session_id":"s2","total_cost_usd":0.01,"num_turns":1,"structured_output":{"ok":true}}'
`;
      await writeFile(claudePath, script);
      await chmod(claudePath, 0o755);
      try {
        const env = await runClaude({
          claudeBin: claudePath,
          userPrompt: 'x',
          schemaJson: {},
          maxTurns: 1,
          maxBudgetUsd: 0.01,
          retryOnTransient: true,
          retryDelayMs: 10,
        });
        assert.equal(env.session_id, 's2');
        const count = Number(await readFile(counterPath, 'utf8'));
        assert.equal(count, 2);
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  },
  {
    name: 'does NOT retry permanent envelope errors (e.g. 400 invalid_request)',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'claude-perm-'));
      const counterPath = join(dir, 'count');
      const claudePath = join(dir, 'claude');
      await writeFile(counterPath, '0');
      const script = `#!/bin/bash
cat > /dev/null
n=$(cat ${counterPath})
echo $((n+1)) > ${counterPath}
echo '{"type":"result","is_error":true,"result":"API Error: 400 invalid_request_error","total_cost_usd":0,"num_turns":0,"session_id":"s"}'
exit 1
`;
      await writeFile(claudePath, script);
      await chmod(claudePath, 0o755);
      try {
        const env = await runClaude({
          claudeBin: claudePath,
          userPrompt: 'x',
          schemaJson: {},
          maxTurns: 1,
          maxBudgetUsd: 0.01,
          retryOnTransient: true,
          retryDelayMs: 10,
        });
        assert.equal(env.is_error, true);
        const count = Number(await readFile(counterPath, 'utf8'));
        assert.equal(count, 1);
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  },
  {
    name: 'retries once on transient 5xx-style failure',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'claude-retry-'));
      const counterPath = join(dir, 'count');
      const claudePath = join(dir, 'claude');
      await writeFile(counterPath, '0');
      const script = `#!/bin/bash
cat > /dev/null
n=$(cat ${counterPath})
echo $((n+1)) > ${counterPath}
if [ "$n" = "0" ]; then echo "529 overloaded" >&2; exit 1; fi
echo '{"session_id":"s","total_cost_usd":0.01,"num_turns":1,"structured_output":{"ok":true}}'
`;
      await writeFile(claudePath, script);
      await chmod(claudePath, 0o755);
      try {
        const env = await runClaude({
          claudeBin: claudePath,
          userPrompt: 'x',
          schemaJson: {},
          maxTurns: 1,
          maxBudgetUsd: 0.01,
          retryOnTransient: true,
          retryDelayMs: 10,
        });
        assert.equal(env.session_id, 's');
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  },
  {
    name: 'times out and does not retry hung invocations',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'claude-timeout-'));
      const claudePath = join(dir, 'claude');
      const script = `#!/bin/bash
cat > /dev/null
sleep 5
echo '{"session_id":"late","total_cost_usd":0,"num_turns":1,"structured_output":{"ok":true}}'
`;
      await writeFile(claudePath, script);
      await chmod(claudePath, 0o755);
      try {
        const started = Date.now();
        let spawnCount = 0;
        await assert.rejects(() => runClaude({
          claudeBin: claudePath,
          userPrompt: 'x',
          schemaJson: {},
          maxTurns: 1,
          maxBudgetUsd: 0.01,
          retryOnTransient: true,
          retryDelayMs: 10,
          timeoutMs: 250,
          killGraceMs: 10,
          onSpawn: () => { spawnCount++; },
        }), (err) => {
          assert.equal(err.kind, 'timeout');
          assert.equal(err.timeout_ms, 250);
          assert.ok(err.elapsed_ms >= 200, `elapsed_ms too small: ${err.elapsed_ms}`);
          assert.ok(err.pid > 0, `expected pid, got ${err.pid}`);
          return true;
        });
        assert.ok(Date.now() - started < 1000, 'timeout test took too long');
        assert.equal(spawnCount, 1);
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  },
  {
    name: 'does not retry a transient failure more than once',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'claude-one-retry-'));
      const counterPath = join(dir, 'count');
      const claudePath = join(dir, 'claude');
      await writeFile(counterPath, '0');
      const script = `#!/bin/bash
cat > /dev/null
n=$(cat ${counterPath})
echo $((n+1)) > ${counterPath}
echo "529 overloaded" >&2
exit 1
`;
      await writeFile(claudePath, script);
      await chmod(claudePath, 0o755);
      try {
        await assert.rejects(() => runClaude({
          claudeBin: claudePath,
          userPrompt: 'x',
          schemaJson: {},
          maxTurns: 1,
          maxBudgetUsd: 0.01,
          retryOnTransient: true,
          retryDelayMs: 10,
        }), /529|overloaded|claude exit/);
        const count = Number(await readFile(counterPath, 'utf8'));
        assert.equal(count, 2);
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  },
  {
    name: 'thrown errors carry err.kind for orchestrator classification',
    fn: async () => {
      // arg_invalid
      await assert.rejects(
        () => runClaude({ schemaJson: {}, maxTurns: 1, maxBudgetUsd: 0.01 }),
        (err) => err.kind === 'arg_invalid'
      );
      // budget_exhausted (ledger reports 0 remaining)
      await withStub('cat > /dev/null; echo \'{}\'', async (claudePath) => {
        const ledger = { remaining: () => 0, record: () => {} };
        await assert.rejects(
          () => runClaude({ claudeBin: claudePath, userPrompt: 'x', schemaJson: {}, maxTurns: 1, maxBudgetUsd: 1, budgetLedger: ledger, retryOnTransient: false }),
          (err) => err.kind === 'budget_exhausted'
        );
      });
      // exit_nonzero
      await withStub('cat > /dev/null; exit 7', async (claudePath) => {
        await assert.rejects(
          () => runClaude({ claudeBin: claudePath, userPrompt: 'x', schemaJson: {}, maxTurns: 1, maxBudgetUsd: 0.01, retryOnTransient: false }),
          (err) => err.kind === 'exit_nonzero' && err.code === 7
        );
      });
      // stdout_not_json
      await withStub('cat > /dev/null; echo "not json"', async (claudePath) => {
        await assert.rejects(
          () => runClaude({ claudeBin: claudePath, userPrompt: 'x', schemaJson: {}, maxTurns: 1, maxBudgetUsd: 0.01 }),
          (err) => err.kind === 'stdout_not_json'
        );
      });
    },
  },
];
