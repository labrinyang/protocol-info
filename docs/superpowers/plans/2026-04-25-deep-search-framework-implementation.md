# Deep-Research Framework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `protocol-info` from a bash-heavy single-prompt crawler to a reusable deep-research framework with a protocol-info consumer adapter — preserving the user-facing CLI/plugin UX, shipping in 9 reversible phases.

**Architecture:** Monorepo with `framework/` (generic deep-research orchestration) and `consumers/protocol-info/` (adapter providing schemas, prompts, fetchers, post-processing). Hybrid `run.sh` shim + Node orchestrator. Zero runtime deps, ESM `.mjs`. Each phase is one independently-revertable commit; `run.sh` keeps running through phases 1–8.

**Tech Stack:** Node 18+ stdlib only (`fs/promises`, `child_process`, `url`, `path`, `crypto`, `process`); bash 3.2+ entry shim; `claude` CLI subprocess; `jq` only in legacy `run.sh` paths during migration.

**Spec:** `docs/superpowers/specs/2026-04-25-deep-search-framework-design.md` (commit `4b834da`).

## Deep Search Philosophy And Review Corrections

These are hard requirements for implementers. The model gets broad freedom to
research, compare conflicting sources, and overrule structured evidence when it
has better fetched evidence. The framework still owns deterministic contracts:

- Final records are `OK` only after normalization and schema validation.
- i18n and dashboard export run only from the final schema-passing `record.json`.
- `--rootdata-id`, `--model`, `--max-turns`, `--max-budget`, `--i18n`,
  `--i18n-parallel`, and `--i18n-model` must pass through to the stage that
  uses them; no parsed flag may be silently ignored.
- `--max-budget` is a single-provider total LLM hard cap. Manifest budgets are
  defaults; the orchestrator computes effective per-stage caps and records them
  in `meta.json`.
- R2 emits `changes[]` in addition to findings/gaps. Missing change provenance
  is an audit warning or high-confidence suppression, not a blanket ban on model
  judgment.
- RootData `validated_overrides` are evidence, not unconditional post-R2
  overwrites. `audits.lastScannedAt` is crawler metadata and is overwritten
  deterministically before validation.
- Slice coherence checks validation semantics, not annotation text. Ignore
  `$schema`, `$id`, `title`, and `description`.
- Deep Search means default-on whole-record synthesis plus bounded iterative
  deepening. R2 is not a repair-only pass; it reviews the complete R1 result,
  may request structured searches, and stops only at `max_research_rounds` or
  budget/gap exhaustion.
- RootData is both an initial evidence fetcher and a structured search channel.
  Its `/open/ser_inv` project/person search results are evidence for the model,
  not commands for the framework.
- Guardrails are acceptance gates after model judgment, not prompt-level
  shackles that prevent useful exploration. Rejections must be logged as
  `changes[]`/gaps/meta so future rounds or humans can inspect them.

---

## File Structure (post-migration)

```
framework/
├── cli.mjs                         # entry called by run.sh
├── orchestrator.mjs                # R0→R1→R2+→normalize→validate→i18n→export pipeline
├── claude-wrapper.mjs              # spawn `claude -p`, schema-forced, retry, cost cap
├── parallel-runner.mjs             # bounded promise queue
├── fetcher-dispatcher.mjs          # parallel-call manifest fetchers
├── search-channel.mjs              # execute model-requested structured searches
├── subtask-runner.mjs              # render prompt → claude → parse {slice,findings,gaps,handoff_notes}
├── merger.mjs                      # N slices → record + findings + gaps + handoffs + audit-first R2 guard
├── evidence-diff.mjs               # deterministic post-R1 evidence comparisons
├── i18n-stage.mjs                  # generic Haiku translation
├── normalizer-stage.mjs            # deterministic pre-validation normalizers
├── schema-validator.mjs            # ← from validate.mjs
├── json-extract.mjs                # ← from extract-json.mjs
├── manifest-loader.mjs             # read+validate consumer manifest, resolve paths
└── schemas/
    ├── findings.schema.json
    ├── changes.schema.json
    ├── gaps.schema.json
    └── consumer-manifest.schema.json

consumers/protocol-info/
├── manifest.json
├── prompts/
│   ├── system.md
│   ├── metadata.user.md.tmpl
│   ├── team.user.md.tmpl
│   ├── funding.user.md.tmpl
│   ├── audits.user.md.tmpl
│   ├── reconcile.user.md.tmpl
│   ├── i18n.system.md
│   └── i18n.user.md.tmpl
├── schemas/
│   ├── full.json
│   ├── metadata.slice.json
│   ├── team.slice.json
│   ├── funding.slice.json
│   ├── audits.slice.json
│   └── i18n.json
├── fetchers/
│   ├── rootdata.mjs
│   └── defillama.mjs
├── normalizers/
│   └── final.mjs
└── post/
    ├── locale-map.mjs
    └── dashboard-export.mjs

tests/
├── run.mjs                         # custom zero-dep test runner
├── framework/
│   ├── schema-validator.test.mjs
│   ├── json-extract.test.mjs
│   ├── parallel-runner.test.mjs
│   ├── claude-wrapper.test.mjs
│   ├── fetcher-dispatcher.test.mjs
│   ├── search-channel.test.mjs
│   ├── subtask-runner.test.mjs
│   ├── merger.test.mjs
│   ├── evidence-diff.test.mjs
│   ├── i18n-stage.test.mjs
│   └── manifest-loader.test.mjs
└── consumers/protocol-info/
    ├── locale-map.test.mjs
    └── dashboard-export.test.mjs

scripts/
├── check-slice-coherence.mjs       # slice ⊆ full
└── check-all.mjs                   # runs slice-coherence + tests + bash -n

run.sh                              # ≤50 lines after phase 9
```

## Test runner conventions (used by every phase)

`tests/run.mjs` discovers `tests/**/*.test.mjs`; each test file exports `tests` (array of `{name, fn}`). The runner runs them, accumulates pass/fail, exits non-zero on any failure. Tests use Node's built-in `node:assert/strict`.

Standard test file shape:
```js
import { strict as assert } from 'node:assert';
export const tests = [
  { name: 'desc', fn: async () => { /* assertions */ } },
];
```

Run all: `node tests/run.mjs`
Run one: `node tests/run.mjs framework/merger`

---

# Phase 1 — Bootstrap framework + test runner

**Deliverable:** `framework/` directory with the 4 utility modules + `extract-json` + `validate` migrated. Custom test runner. Pre-push script. `run.sh` continues to work; root helper filenames move and caller paths are updated in the same phase.

**Smoke test:** `node tests/run.mjs` exits 0; all unit tests green; `bash -n run.sh` still passes.

---

### Task 1.1: Create directory skeleton

**Files:**
- Create: `framework/`, `framework/schemas/`, `tests/`, `tests/framework/`, `tests/consumers/protocol-info/`, `scripts/`

- [ ] **Step 1: Make directories**

```bash
mkdir -p framework/schemas tests/framework tests/consumers/protocol-info scripts
```

- [ ] **Step 2: Add a `.gitkeep` so empty dirs are committable**

```bash
touch framework/schemas/.gitkeep tests/framework/.gitkeep tests/consumers/protocol-info/.gitkeep scripts/.gitkeep
```

- [ ] **Step 3: Verify**

```bash
ls -la framework/ tests/ scripts/
```

Expected: directories exist with `.gitkeep` markers.

- [ ] **Step 4: Commit**

```bash
git add framework/ tests/ scripts/
git commit -m "chore(scaffold): add framework/, tests/, scripts/ skeleton for deep-research migration"
```

---

### Task 1.2: Write the test runner

**Files:**
- Create: `tests/run.mjs`

- [ ] **Step 1: Write `tests/run.mjs`**

```js
#!/usr/bin/env node
// Zero-dep test runner. Discovers tests/**/*.test.mjs, runs each, reports pass/fail.
// Each test file exports `tests` = [{name, fn}]. fn may be async; throws/rejects = fail.
//
// Usage:
//   node tests/run.mjs                         # run all
//   node tests/run.mjs framework/merger        # filter by substring of file path

import { readdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const filter = process.argv[2] || '';

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && ent.name.endsWith('.test.mjs')) yield p;
  }
}

const RED = '\x1b[31m', GREEN = '\x1b[32m', GREY = '\x1b[90m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
const failures = [];

for await (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (filter && !rel.includes(filter)) continue;
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    console.error(`${RED}LOAD FAIL${RESET} ${rel}: ${err.message}`);
    failed++;
    failures.push({ file: rel, name: '(load)', err });
    continue;
  }
  if (!Array.isArray(mod.tests)) {
    console.error(`${RED}NO TESTS${RESET} ${rel} (missing exported \`tests\`)`);
    failed++;
    continue;
  }
  for (const t of mod.tests) {
    process.stdout.write(`${GREY}${rel}${RESET} :: ${t.name} ... `);
    try {
      await t.fn();
      console.log(`${GREEN}ok${RESET}`);
      passed++;
    } catch (err) {
      console.log(`${RED}FAIL${RESET}`);
      console.log(`  ${err.stack || err.message}`);
      failed++;
      failures.push({ file: rel, name: t.name, err });
    }
  }
}

console.log(`\n${passed + failed} tests · ${GREEN}${passed} passed${RESET} · ${failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed'}`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Add a smoke test for the runner itself**

Create `tests/runner-self.test.mjs`:
```js
import { strict as assert } from 'node:assert';
export const tests = [
  { name: 'runner can execute a passing test', fn: async () => { assert.equal(1 + 1, 2); } },
];
```

- [ ] **Step 3: Run the runner**

```bash
node tests/run.mjs
```

Expected output ends with `1 tests · 1 passed · 0 failed` and exit 0.

- [ ] **Step 4: Commit**

```bash
git add tests/run.mjs tests/runner-self.test.mjs
git commit -m "test: add zero-dep test runner with self-test"
```

---

### Task 1.3: Migrate validate.mjs → framework/schema-validator.mjs

**Files:**
- Move: `validate.mjs` → `framework/schema-validator.mjs`
- Modify: any caller currently referencing `validate.mjs` (search first)
- Test: `tests/framework/schema-validator.test.mjs`

- [ ] **Step 1: Search for callers**

```bash
grep -rn 'validate.mjs' --include='*.sh' --include='*.mjs' --include='*.md'
```

Expected: hits in `run.sh` (the `node "$SCRIPT_DIR/validate.mjs"` line) and possibly README.

- [ ] **Step 2: Move the file with git mv (preserves history)**

```bash
git mv validate.mjs framework/schema-validator.mjs
```

- [ ] **Step 3: Update `run.sh` reference**

In `run.sh`, find and replace `"$SCRIPT_DIR/validate.mjs"` → `"$SCRIPT_DIR/framework/schema-validator.mjs"`.

```bash
sed -i.bak 's|"$SCRIPT_DIR/validate.mjs"|"$SCRIPT_DIR/framework/schema-validator.mjs"|g' run.sh && rm run.sh.bak
```

- [ ] **Step 4: Update README + CHANGELOG references**

```bash
grep -l 'validate.mjs' README.md CHANGELOG.md 2>/dev/null
```

For each match, replace `validate.mjs` → `framework/schema-validator.mjs` (or rephrase to "schema validator").

- [ ] **Step 5: Write the test**

Create `tests/framework/schema-validator.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runValidator(schema, instance) {
  const tmp = await mkdtemp(join(tmpdir(), 'sv-'));
  const schemaPath = join(tmp, 'schema.json');
  const instancePath = join(tmp, 'instance.json');
  await writeFile(schemaPath, JSON.stringify(schema));
  await writeFile(instancePath, JSON.stringify(instance));
  const res = spawnSync('node', ['framework/schema-validator.mjs', instancePath, '--schema', schemaPath], { encoding: 'utf8' });
  await rm(tmp, { recursive: true });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

export const tests = [
  {
    name: 'validates a passing instance',
    fn: async () => {
      const r = await runValidator(
        { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
        { x: 1 }
      );
      assert.equal(r.code, 0);
    },
  },
  {
    name: 'rejects a failing instance',
    fn: async () => {
      const r = await runValidator(
        { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
        { x: 'not a number' }
      );
      assert.notEqual(r.code, 0);
    },
  },
];
```

If `framework/schema-validator.mjs` does not yet accept a `--schema <path>` flag (the original `validate.mjs` may have a hard-coded schema), update its argv parsing to accept it. Keep backward-compatible default of `schema/earn-protocol-info.schema.json` so `run.sh`'s existing call still works.

- [ ] **Step 6: Run the test**

```bash
node tests/run.mjs framework/schema-validator
```

Expected: 2 passed.

- [ ] **Step 7: Verify run.sh dry-run still works**

```bash
./run.sh --dry-run --display-name "MigrationCheck" --type simple_earn 2>&1 | head -10
```

Expected: banner prints, no error about missing `validate.mjs`.

- [ ] **Step 8: Commit**

```bash
git add framework/schema-validator.mjs run.sh tests/framework/schema-validator.test.mjs README.md CHANGELOG.md
git commit -m "refactor: migrate validate.mjs to framework/schema-validator.mjs

- git mv preserves history
- run.sh updated to new path
- adds CLI --schema flag for arbitrary schema files
- adds unit test"
```

---

### Task 1.4: Migrate extract-json.mjs → framework/json-extract.mjs

**Files:**
- Move: `extract-json.mjs` → `framework/json-extract.mjs`
- Modify: `run.sh` (one reference)
- Test: `tests/framework/json-extract.test.mjs`

- [ ] **Step 1: Move**

```bash
git mv extract-json.mjs framework/json-extract.mjs
```

- [ ] **Step 2: Update run.sh**

```bash
sed -i.bak 's|"$SCRIPT_DIR/extract-json.mjs"|"$SCRIPT_DIR/framework/json-extract.mjs"|g' run.sh && rm run.sh.bak
```

- [ ] **Step 3: Write the test**

Create `tests/framework/json-extract.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

function extract(input) {
  const r = spawnSync('node', ['framework/json-extract.mjs'], { input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const tests = [
  {
    name: 'extracts plain JSON object',
    fn: async () => {
      const r = extract('{"a":1}');
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), { a: 1 });
    },
  },
  {
    name: 'extracts JSON from markdown fence',
    fn: async () => {
      const r = extract('Here:\n```json\n{"a":1}\n```\nbye');
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), { a: 1 });
    },
  },
  {
    name: 'extracts first balanced object from prose',
    fn: async () => {
      const r = extract('text {"x":2,"nested":{"y":3}} more text');
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), { x: 2, nested: { y: 3 } });
    },
  },
  {
    name: 'fails on no JSON',
    fn: async () => {
      const r = extract('only prose, no braces');
      assert.notEqual(r.code, 0);
    },
  },
];
```

- [ ] **Step 4: Run the test**

```bash
node tests/run.mjs framework/json-extract
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add framework/json-extract.mjs run.sh tests/framework/json-extract.test.mjs
git commit -m "refactor: migrate extract-json.mjs to framework/json-extract.mjs"
```

---

### Task 1.5: Write framework/parallel-runner.mjs

**Files:**
- Create: `framework/parallel-runner.mjs`
- Test: `tests/framework/parallel-runner.test.mjs`

- [ ] **Step 1: Write the test first**

Create `tests/framework/parallel-runner.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { runWithLimit } from '../../framework/parallel-runner.mjs';

export const tests = [
  {
    name: 'runs all tasks and preserves order in returned results',
    fn: async () => {
      const results = await runWithLimit(2, [
        () => Promise.resolve(1),
        () => Promise.resolve(2),
        () => Promise.resolve(3),
        () => Promise.resolve(4),
      ]);
      assert.deepEqual(results, [1, 2, 3, 4]);
    },
  },
  {
    name: 'respects concurrency limit',
    fn: async () => {
      let active = 0;
      let peak = 0;
      const tasks = Array.from({ length: 8 }, () => async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 20));
        active--;
        return 'ok';
      });
      await runWithLimit(3, tasks);
      assert.ok(peak <= 3, `peak ${peak} exceeded limit 3`);
      assert.ok(peak >= 2, `peak ${peak} suspiciously low — concurrency may be 1`);
    },
  },
  {
    name: 'collects failures alongside successes when collectErrors=true',
    fn: async () => {
      const results = await runWithLimit(2, [
        () => Promise.resolve('a'),
        () => Promise.reject(new Error('boom')),
        () => Promise.resolve('c'),
      ], { collectErrors: true });
      assert.equal(results[0].ok, true);
      assert.equal(results[0].value, 'a');
      assert.equal(results[1].ok, false);
      assert.match(results[1].error.message, /boom/);
      assert.equal(results[2].ok, true);
      assert.equal(results[2].value, 'c');
    },
  },
];
```

- [ ] **Step 2: Run, verify it fails**

```bash
node tests/run.mjs framework/parallel-runner
```

Expected: LOAD FAIL (module doesn't exist yet).

- [ ] **Step 3: Implement `framework/parallel-runner.mjs`**

```js
// Bounded promise queue. Replaces the bash `wait "${pids[0]}"` pattern.
// runWithLimit(n, tasks, opts?) — tasks is an array of () => Promise<T>.
// Returns Promise<T[]> in input order. With opts.collectErrors=true, returns
// Array<{ok:true,value} | {ok:false,error}> instead of throwing.

export async function runWithLimit(limit, tasks, opts = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`runWithLimit: limit must be positive integer, got ${limit}`);
  }
  const results = new Array(tasks.length);
  let next = 0;
  const collectErrors = !!opts.collectErrors;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      try {
        const v = await tasks[idx]();
        results[idx] = collectErrors ? { ok: true, value: v } : v;
      } catch (err) {
        if (collectErrors) {
          results[idx] = { ok: false, error: err };
        } else {
          throw err;
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
node tests/run.mjs framework/parallel-runner
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add framework/parallel-runner.mjs tests/framework/parallel-runner.test.mjs
git commit -m "feat(framework): add parallel-runner with bounded concurrency"
```

---

### Task 1.6: Write framework/claude-wrapper.mjs

**Files:**
- Create: `framework/claude-wrapper.mjs`
- Test: `tests/framework/claude-wrapper.test.mjs`

- [ ] **Step 1: Write the test using a stub claude binary**

Create `tests/framework/claude-wrapper.test.mjs`:
```js
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
    name: 'throws on non-zero exit',
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
        });
        assert.equal(env.session_id, 's');
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
        }), /529|overloaded|claude exit/);
        const count = Number(await readFile(counterPath, 'utf8'));
        assert.equal(count, 2);
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  },
];
```

- [ ] **Step 2: Run, verify fails (module not yet present)**

```bash
node tests/run.mjs framework/claude-wrapper
```

Expected: LOAD FAIL.

- [ ] **Step 3: Implement `framework/claude-wrapper.mjs`**

```js
// Spawns `claude -p` with schema-forced output. Handles at most one retry on
// transient failures, parses the envelope, returns it. Higher-level extraction
// of structured_output happens in subtask-runner.

import { spawn } from 'node:child_process';

const TRANSIENT_PATTERNS = [
  /529/i,
  /overloaded/i,
  /timeout/i,
  /ECONNRESET/i,
  /503/i,
  /502/i,
];

export async function runClaude({
  claudeBin = 'claude',
  systemPrompt = '',
  userPrompt,
  schemaJson,
  maxTurns,
  maxBudgetUsd,
  permissionMode = 'bypassPermissions',
  allowedTools = 'WebFetch,WebSearch',
  resumeSession = null,
  model = null,
  retryOnTransient = true,
  retryDelayMs = 2000,
  budgetLedger = null,
}) {
  if (!userPrompt) throw new Error('runClaude: userPrompt is required');
  if (!schemaJson) throw new Error('runClaude: schemaJson is required');

  const attempt = async () => {
    const attemptBudget = budgetLedger ? Math.min(maxBudgetUsd, budgetLedger.remaining()) : maxBudgetUsd;
    if (!(attemptBudget > 0)) throw new Error('max-budget exhausted before claude attempt');
    const env = await spawnAndCollect({
      claudeBin, systemPrompt, userPrompt, schemaJson,
      maxTurns, maxBudgetUsd: attemptBudget, permissionMode, allowedTools, resumeSession, model,
    });
    if (budgetLedger && Number.isFinite(env.total_cost_usd)) budgetLedger.record(env.total_cost_usd);
    return env;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!retryOnTransient || !isTransient(err)) throw err;
    await sleep(retryDelayMs);
    return await attempt();
  }
}

function isTransient(err) {
  const msg = (err && err.message) || '';
  const stderr = (err && err.stderr) || '';
  return TRANSIENT_PATTERNS.some(p => p.test(msg) || p.test(stderr));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnAndCollect({
  claudeBin, systemPrompt, userPrompt, schemaJson,
  maxTurns, maxBudgetUsd, permissionMode, allowedTools, resumeSession, model,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '-',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schemaJson),
      '--max-turns', String(maxTurns),
      '--max-budget-usd', String(maxBudgetUsd),
      '--permission-mode', permissionMode,
      '--allowed-tools', allowedTools,
    ];
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    if (resumeSession) args.push('--resume', resumeSession);
    if (model) args.push('--model', model);

    const proc = spawn(claudeBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', err => reject(Object.assign(err, { stderr })));
    proc.on('close', code => {
      if (code !== 0) {
        return reject(Object.assign(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`), { code, stderr, stdout }));
      }
      let env;
      try { env = JSON.parse(stdout); }
      catch (e) { return reject(Object.assign(new Error(`claude stdout not JSON: ${e.message}`), { stdout, stderr })); }
      resolve(env);
    });
    proc.stdin.end(userPrompt);
  });
}
```

`budgetLedger` is supplied by stage CLIs when a user-level `--max-budget` cap is
active. The wrapper must read remaining budget before the initial attempt and
before the single retry; it must not hand each attempt the full original cap.

- [ ] **Step 4: Run, verify pass**

```bash
node tests/run.mjs framework/claude-wrapper
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add framework/claude-wrapper.mjs tests/framework/claude-wrapper.test.mjs
git commit -m "feat(framework): add claude-wrapper with transient-retry and cost cap"
```

---

### Task 1.7: Write scripts/check-all.mjs

**Files:**
- Create: `scripts/check-all.mjs`

- [ ] **Step 1: Implement**

```js
#!/usr/bin/env node
// Composite pre-push check: bash syntax + tests + (later) slice coherence.
// Each step prints its own header. Exits non-zero on first failure.

import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'bash -n run.sh', cmd: 'bash', args: ['-n', 'run.sh'] },
  { name: 'tests/run.mjs', cmd: 'node', args: ['tests/run.mjs'] },
  // slice-coherence appended in phase 4
];

let ok = true;
for (const s of steps) {
  console.log(`\n── ${s.name} ──`);
  const r = spawnSync(s.cmd, s.args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ ${s.name} failed (exit ${r.status})`);
    ok = false;
    break;
  }
  console.log(`✓ ${s.name}`);
}
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run**

```bash
node scripts/check-all.mjs
```

Expected: both steps pass, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-all.mjs
git commit -m "chore: add scripts/check-all.mjs (bash syntax + tests)"
```

---

### Task 1.8: Phase 1 wrap-up — verify run.sh still works end-to-end

**Files:** none modified

- [ ] **Step 1: Dry-run smoke**

```bash
./run.sh --dry-run --display-name "Phase1Smoke" --type simple_earn 2>&1 | head -20
```

Expected: banner + rendered prompt, no errors.

- [ ] **Step 2: Run check-all**

```bash
node scripts/check-all.mjs
```

Expected: green.

- [ ] **Step 3: Verify directory state**

```bash
ls framework/ tests/ scripts/
```

Expected:
- `framework/`: `claude-wrapper.mjs`, `json-extract.mjs`, `parallel-runner.mjs`, `schema-validator.mjs`, `schemas/`
- `tests/`: `run.mjs`, `runner-self.test.mjs`, `framework/`, `consumers/`
- `scripts/`: `check-all.mjs`

No commit — just verification. Phase 1 already committed via the per-task commits above.

---

# Phase 2 — Fetcher framework

**Deliverable:** `consumers/protocol-info/fetchers/{rootdata,defillama}.mjs`, `framework/fetcher-dispatcher.mjs`. `run.sh` calls dispatcher instead of `preprocess-rootdata.mjs` directly. Evidence packet has top-level keys per fetcher.

**Smoke test:** Real-slug run with `ROOTDATA_API_KEY` set produces evidence packet containing both `rootdata` and `defillama` subtrees.

---

### Task 2.1: Define and document fetcher interface

**Files:**
- Create: `framework/FETCHER_INTERFACE.md` (developer-facing contract)

- [ ] **Step 1: Write contract doc**

```markdown
# Fetcher interface

Each fetcher is an ESM module that exports a default async function:

```js
export default async function fetch({ slug, displayName, hints, rootdataId, env, logger }) {
  // ... call external API ...
  return {
    name: 'rootdata',           // matches manifest fetchers[].name
    ok: true,                   // false if the fetch failed; framework still includes it
    data: { /* fetcher-shaped */ },
    cost_usd: 0,                // 0 unless the fetcher is paid + tracks
    fetched_at: '2026-04-25T...'
  };
}
```

Fetchers may also export a structured search function:

```js
export async function search({ query, type, limit = 5, env, logger }) {
  return {
    channel: 'rootdata',
    query,
    type,
    ok: true,
    results: [ /* provider-shaped */ ],
    fetched_at: '2026-04-25T...'
  };
}
```

The framework only calls `search` when a synthesis/deepening round emits an
approved `search_requests[]` entry. Search results are appended to the evidence
packet as `search_results[]`; they never overwrite record fields directly.

`env` is the process env (read-only). `logger` has `.info(msg)` and `.warn(msg)`.

A fetcher MUST NOT throw on expected failures (404, missing key, rate limit) —
return `{ok:false, data:null, error: 'reason'}`. Framework treats throws as
unhandled bugs.

Inner shape of `data` is the fetcher's choice. Keep it stable across versions
(prompts depend on the structure via manifest `evidence_keys`).
```

- [ ] **Step 2: Commit**

```bash
git add framework/FETCHER_INTERFACE.md
git commit -m "docs(framework): document fetcher module interface"
```

---

### Task 2.2: Migrate preprocess-rootdata.mjs → consumers/protocol-info/fetchers/rootdata.mjs

**Files:**
- Move: `preprocess-rootdata.mjs` → `consumers/protocol-info/fetchers/rootdata.mjs`
- Modify: the new file (refactor to fetcher interface)
- Test: `tests/consumers/protocol-info/rootdata.test.mjs` (smoke + interface check)
- Modify: `run.sh` references

- [ ] **Step 1: Make destination directory**

```bash
mkdir -p consumers/protocol-info/fetchers
```

- [ ] **Step 2: Move with git mv**

```bash
git mv preprocess-rootdata.mjs consumers/protocol-info/fetchers/rootdata.mjs
```

- [ ] **Step 3: Refactor — wrap existing CLI behavior in the fetcher interface**

Read `consumers/protocol-info/fetchers/rootdata.mjs`. The current file is a CLI script reading `--slug`, `--display-name`, etc. and writing a packet to `--output`. Add a default-export function that wraps the same logic without writing to disk:

```js
// At top of file, after existing imports:
export default async function fetch({ slug, displayName, hints, rootdataId, env, logger }) {
  if (!env.ROOTDATA_API_KEY) {
    return {
      name: 'rootdata', ok: false, data: null,
      error: 'ROOTDATA_API_KEY not set',
      cost_usd: 0, fetched_at: new Date().toISOString(),
    };
  }
  try {
    // Reuse existing internal helpers — the CLI body becomes a thin wrapper
    // around this function.
    const data = await collectRootDataPacket({ slug, displayName, hints, rootdataId, apiKey: env.ROOTDATA_API_KEY, logger });
    return { name: 'rootdata', ok: true, data, cost_usd: 0, fetched_at: new Date().toISOString() };
  } catch (err) {
    logger.warn(`rootdata fetch failed: ${err.message}`);
    return { name: 'rootdata', ok: false, data: null, error: err.message, cost_usd: 0, fetched_at: new Date().toISOString() };
  }
}

// Existing CLI entry-point (if module run directly): keep, but route through the new function.
if (import.meta.url === `file://${process.argv[1]}`) {
  // ... existing CLI argv parsing ...
  // Replace the "do everything" body with:
  const result = await fetch({ slug, displayName, hints, rootdataId, env: process.env, logger: console });
  await writeFile(outputPath, JSON.stringify(result.data, null, 2));
}
```

Refactor the body of the original script into `async function collectRootDataPacket(...)` so both the CLI mode and the new fetcher export call it. Preserve the legacy `--rootdata-id` path by passing it as `rootdataId` into `collectRootDataPacket` and using it before name search.

Also export RootData as a search channel by wrapping the existing
`/open/ser_inv` helpers:

```js
export async function search({ query, type = 'project', limit = 5, env, logger }) {
  if (!env.ROOTDATA_API_KEY) {
    return { channel: 'rootdata', query, type, ok: false, error: 'ROOTDATA_API_KEY not set', results: [] };
  }
  const rootType = type === 'person' ? 3 : 1;
  try {
    const results = await apiPost('/open/ser_inv', { query, type: rootType }, env.ROOTDATA_API_KEY);
    return {
      channel: 'rootdata',
      query,
      type,
      ok: true,
      results: Array.isArray(results) ? results.slice(0, limit) : [],
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn?.(`rootdata search failed: ${err.message}`);
    return { channel: 'rootdata', query, type, ok: false, error: err.message, results: [], fetched_at: new Date().toISOString() };
  }
}
```

This keeps RootData as a model-accessible research channel during deepening
rounds instead of a one-time preprocessor.

- [ ] **Step 4: Update `run.sh`**

```bash
sed -i.bak 's|"$SCRIPT_DIR/preprocess-rootdata.mjs"|"$SCRIPT_DIR/consumers/protocol-info/fetchers/rootdata.mjs"|g' run.sh && rm run.sh.bak
sed -i.bak 's|PREPROCESS_SCRIPT="$SCRIPT_DIR/preprocess-rootdata.mjs"|PREPROCESS_SCRIPT="$SCRIPT_DIR/consumers/protocol-info/fetchers/rootdata.mjs"|' run.sh && rm run.sh.bak
```

- [ ] **Step 5: Write the test**

Create `tests/consumers/protocol-info/rootdata.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import fetch, { search } from '../../../consumers/protocol-info/fetchers/rootdata.mjs';

export const tests = [
  {
    name: 'fetcher returns ok:false when ROOTDATA_API_KEY missing',
    fn: async () => {
      const result = await fetch({
        slug: 'pendle', displayName: 'Pendle', hints: '',
        env: {}, logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(result.name, 'rootdata');
      assert.equal(result.ok, false);
      assert.match(result.error, /ROOTDATA_API_KEY/);
    },
  },
  {
    name: 'fetcher result has expected envelope shape',
    fn: async () => {
      const result = await fetch({
        slug: 'pendle', displayName: 'Pendle', hints: '',
        env: {}, logger: { info: () => {}, warn: () => {} },
      });
      assert.ok('name' in result);
      assert.ok('ok' in result);
      assert.ok('cost_usd' in result);
      assert.ok('fetched_at' in result);
    },
  },
  {
    name: 'search channel returns ok:false when ROOTDATA_API_KEY missing',
    fn: async () => {
      const result = await search({
        query: 'Pendle founder',
        type: 'person',
        env: {},
        logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(result.channel, 'rootdata');
      assert.equal(result.ok, false);
      assert.deepEqual(result.results, []);
    },
  },
];
```

- [ ] **Step 6: Run the test**

```bash
node tests/run.mjs consumers/protocol-info/rootdata
```

Expected: 3 passed.

- [ ] **Step 7: Verify CLI mode still works (run.sh path)**

```bash
./run.sh --dry-run --display-name "RDCheck" --type simple_earn 2>&1 | head -5
```

Expected: banner prints, no module-not-found error.

- [ ] **Step 8: Commit**

```bash
git add consumers/protocol-info/fetchers/rootdata.mjs run.sh tests/consumers/protocol-info/rootdata.test.mjs
git commit -m "refactor: move rootdata to consumers/protocol-info/fetchers/

- migrates preprocess-rootdata.mjs → consumers/protocol-info/fetchers/rootdata.mjs
- adds default-export following framework FETCHER_INTERFACE
- adds RootData search channel export for deepening rounds
- preserves CLI-mode entry for run.sh compatibility
- adds unit tests covering missing-key path"
```

---

### Task 2.3: Write consumers/protocol-info/fetchers/defillama.mjs

**Files:**
- Create: `consumers/protocol-info/fetchers/defillama.mjs`
- Test: `tests/consumers/protocol-info/defillama.test.mjs`

DeFiLlama API basics (free, no key): `https://api.llama.fi/protocol/<slug>` returns TVL, chains, category. We'll fuzzy-match the protocol's display name to a DeFiLlama slug via `https://api.llama.fi/protocols`.

- [ ] **Step 1: Write the test**

Create `tests/consumers/protocol-info/defillama.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { matchProtocol } from '../../../consumers/protocol-info/fetchers/defillama.mjs';

export const tests = [
  {
    name: 'matchProtocol picks exact name match over fuzzy',
    fn: async () => {
      const list = [
        { name: 'Pendle V2', slug: 'pendle-v2', tvl: 1 },
        { name: 'Pendle', slug: 'pendle', tvl: 100 },
        { name: 'Pendulum', slug: 'pendulum', tvl: 5 },
      ];
      const m = matchProtocol(list, 'Pendle');
      assert.equal(m.slug, 'pendle');
    },
  },
  {
    name: 'matchProtocol falls back to highest-TVL prefix match',
    fn: async () => {
      const list = [
        { name: 'Pendle V2', slug: 'pendle-v2', tvl: 100 },
        { name: 'PendleSomething', slug: 'pendle-something', tvl: 1 },
      ];
      const m = matchProtocol(list, 'Pendle');
      assert.equal(m.slug, 'pendle-v2');
    },
  },
  {
    name: 'matchProtocol returns null on no match',
    fn: async () => {
      const m = matchProtocol([{ name: 'Aave', slug: 'aave', tvl: 1 }], 'TotallyUnknownXYZ');
      assert.equal(m, null);
    },
  },
];
```

- [ ] **Step 2: Run, verify it fails (module not yet present)**

```bash
node tests/run.mjs consumers/protocol-info/defillama
```

Expected: LOAD FAIL.

- [ ] **Step 3: Implement**

```js
// DeFiLlama fetcher. Free public API, no key required.
// Steps:
//   1. fetch /protocols (list) once, cache for the process
//   2. fuzzy-match displayName → slug
//   3. fetch /protocol/<slug> for TVL, chains, category
//   4. shape into evidence packet subtree

const API = 'https://api.llama.fi';

let _listCache = null;
async function fetchProtocolList(logger) {
  if (_listCache) return _listCache;
  const res = await fetch(`${API}/protocols`, { headers: { 'User-Agent': 'protocol-info/1.0' } });
  if (!res.ok) throw new Error(`defillama /protocols ${res.status}`);
  _listCache = await res.json();
  return _listCache;
}

export function matchProtocol(list, displayName) {
  const target = displayName.trim().toLowerCase();
  // 1. exact name match
  const exact = list.find(p => (p.name || '').toLowerCase() === target);
  if (exact) return exact;
  // 2. prefix match, sorted by TVL desc
  const prefix = list
    .filter(p => (p.name || '').toLowerCase().startsWith(target))
    .sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
  if (prefix.length) return prefix[0];
  return null;
}

export default async function fetch_({ slug, displayName, hints, env, logger }) {
  try {
    const list = await fetchProtocolList(logger);
    const matched = matchProtocol(list, displayName);
    if (!matched) {
      return {
        name: 'defillama', ok: false, data: null,
        error: `no DeFiLlama protocol matches "${displayName}"`,
        cost_usd: 0, fetched_at: new Date().toISOString(),
      };
    }
    const detailRes = await fetch(`${API}/protocol/${matched.slug}`, { headers: { 'User-Agent': 'protocol-info/1.0' } });
    if (!detailRes.ok) throw new Error(`defillama /protocol/${matched.slug} ${detailRes.status}`);
    const detail = await detailRes.json();
    return {
      name: 'defillama',
      ok: true,
      data: {
        defillama_slug: matched.slug,
        tvl_usd: matched.tvl ?? null,
        category: detail.category ?? null,
        chains: detail.chains ?? [],
        listed_at: detail.listedAt ?? null,
        twitter: detail.twitter ?? null,
        url: detail.url ?? null,
      },
      cost_usd: 0,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    logger?.warn?.(`defillama fetch failed: ${err.message}`);
    return {
      name: 'defillama', ok: false, data: null, error: err.message,
      cost_usd: 0, fetched_at: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 4: Run unit tests (no network needed — test only `matchProtocol`)**

```bash
node tests/run.mjs consumers/protocol-info/defillama
```

Expected: 3 passed.

- [ ] **Step 5: Manual smoke (network)**

```bash
node -e "import('./consumers/protocol-info/fetchers/defillama.mjs').then(m => m.default({slug:'pendle',displayName:'Pendle',env:{},logger:console}).then(r => console.log(JSON.stringify(r, null, 2))))"
```

Expected: prints `{name:'defillama', ok:true, data:{defillama_slug:'pendle', tvl_usd: <number>, ...}}`.

- [ ] **Step 6: Commit**

```bash
git add consumers/protocol-info/fetchers/defillama.mjs tests/consumers/protocol-info/defillama.test.mjs
git commit -m "feat(consumer): add defillama fetcher (free public API)"
```

---

### Task 2.4: Write framework/fetcher-dispatcher.mjs

**Files:**
- Create: `framework/fetcher-dispatcher.mjs`
- Test: `tests/framework/fetcher-dispatcher.test.mjs`

- [ ] **Step 1: Write the test using fake fetcher modules**

Create `tests/framework/fetcher-dispatcher.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchFetchers } from '../../framework/fetcher-dispatcher.mjs';

async function withFakeFetcher(body, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'));
  const path = join(dir, 'fake.mjs');
  await writeFile(path, body);
  try { return await fn(path); }
  finally { await rm(dir, { recursive: true }); }
}

export const tests = [
  {
    name: 'dispatches multiple fetchers in parallel and merges by name',
    fn: async () => {
      await withFakeFetcher(
        `export default async () => ({ name: 'a', ok: true, data: {x: 1}, cost_usd: 0, fetched_at: 'now' });`,
        async (aPath) => {
          await withFakeFetcher(
            `export default async () => ({ name: 'b', ok: true, data: {y: 2}, cost_usd: 0, fetched_at: 'now' });`,
            async (bPath) => {
              const packet = await dispatchFetchers({
                fetchers: [
                  { name: 'a', module_abs: aPath, optional: true, required_env: [] },
                  { name: 'b', module_abs: bPath, optional: true, required_env: [] },
                ],
                ctx: { slug: 's', displayName: 'S', hints: '', env: {}, logger: { info: () => {}, warn: () => {} } },
              });
              assert.deepEqual(packet.fetchers_run, ['a', 'b']);
              assert.deepEqual(packet.a, { x: 1 });
              assert.deepEqual(packet.b, { y: 2 });
              assert.equal(packet.fetcher_status.a, 'ok');
              assert.equal(packet.fetcher_status.b, 'ok');
            },
          );
        },
      );
    },
  },
  {
    name: 'continues when an optional fetcher fails',
    fn: async () => {
      await withFakeFetcher(
        `export default async () => ({ name: 'a', ok: false, data: null, error: 'boom', cost_usd: 0, fetched_at: 'now' });`,
        async (aPath) => {
          await withFakeFetcher(
            `export default async () => ({ name: 'b', ok: true, data: {y: 2}, cost_usd: 0, fetched_at: 'now' });`,
            async (bPath) => {
              const packet = await dispatchFetchers({
                fetchers: [
                  { name: 'a', module_abs: aPath, optional: true, required_env: [] },
                  { name: 'b', module_abs: bPath, optional: true, required_env: [] },
                ],
                ctx: { slug: 's', displayName: 'S', hints: '', env: {}, logger: { info: () => {}, warn: () => {} } },
              });
              assert.equal(packet.fetcher_status.a, 'failed: boom');
              assert.equal(packet.fetcher_status.b, 'ok');
              assert.deepEqual(packet.b, { y: 2 });
              assert.equal('a' in packet, false);
            },
          );
        },
      );
    },
  },
];
```

- [ ] **Step 2: Run, verify fail**

```bash
node tests/run.mjs framework/fetcher-dispatcher
```

Expected: LOAD FAIL.

- [ ] **Step 3: Implement**

```js
// Calls all manifest-declared fetchers in parallel via parallel-runner,
// merges results into a single evidence packet.
//
// Output shape:
//   {
//     fetchers_run: ['rootdata', 'defillama', ...],
//     fetcher_status: { rootdata: 'ok' | 'failed: <reason>' | 'skipped: <reason>', ... },
//     <fetcher name>: <fetcher data>,    // only when ok
//     fetched_at: '<ISO>'
//   }

import { runWithLimit } from './parallel-runner.mjs';
import { pathToFileURL } from 'node:url';

export async function dispatchFetchers({ fetchers, ctx, concurrency = 4 }) {
  const status = {};

  const tasks = fetchers.map(f => async () => {
    // env-gating
    const missingEnv = (f.required_env || []).filter(k => !ctx.env[k]);
    if (missingEnv.length > 0) {
      status[f.name] = `skipped: missing env ${missingEnv.join(',')}`;
      return null;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(f.module_abs).href);
    } catch (err) {
      status[f.name] = `failed: import error: ${err.message}`;
      return null;
    }
    if (typeof mod.default !== 'function') {
      status[f.name] = `failed: module has no default export`;
      return null;
    }
    let result;
    try {
      result = await mod.default(ctx);
    } catch (err) {
      status[f.name] = `failed: ${err.message}`;
      return null;
    }
    if (!result || result.ok !== true) {
      status[f.name] = `failed: ${result?.error || 'no data'}`;
      return null;
    }
    status[f.name] = 'ok';
    return result;
  });

  const results = await runWithLimit(concurrency, tasks);

  const packet = {
    fetchers_run: fetchers.map(f => f.name),
    fetcher_status: status,
    fetched_at: new Date().toISOString(),
  };
  for (const r of results) {
    if (r && r.ok) packet[r.name] = r.data;
  }
  return packet;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
node tests/run.mjs framework/fetcher-dispatcher
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add framework/fetcher-dispatcher.mjs tests/framework/fetcher-dispatcher.test.mjs
git commit -m "feat(framework): add fetcher-dispatcher (parallel + merge)"
```

---

### Task 2.5: Wire dispatcher into run.sh

**Files:**
- Modify: `run.sh` — replace direct `node "$PREPROCESS_SCRIPT"` invocation with a call to a new dispatcher entry script.
- Create: `framework/cli/fetch.mjs` — thin CLI wrapper around `dispatchFetchers` for bash to invoke

- [ ] **Step 1: Create the CLI wrapper**

```js
// framework/cli/fetch.mjs — bash-callable entry. Reads a manifest, runs all
// declared fetchers, writes the evidence packet to --output.
//
// Usage: node framework/cli/fetch.mjs --manifest <path> --slug X --display-name Y --hints Z [--rootdata-id ID] --output OUT.json

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { dispatchFetchers } from '../fetcher-dispatcher.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const manifestPath = arg('manifest');
const slug = arg('slug');
const displayName = arg('display-name');
const hints = arg('hints', '');
const rootdataId = arg('rootdata-id', '');
const output = arg('output');

if (!manifestPath || !slug || !displayName || !output) {
  console.error('usage: fetch.mjs --manifest <path> --slug X --display-name Y [--hints Z] [--rootdata-id ID] --output OUT');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const consumerDir = dirname(resolve(manifestPath));

const fetchers = (manifest.fetchers || []).map(f => ({
  ...f,
  module_abs: resolve(consumerDir, f.module),
}));

const packet = await dispatchFetchers({
  fetchers,
  ctx: {
    slug, displayName, hints, rootdataId,
    env: process.env,
    logger: { info: m => console.error(`[fetch] ${m}`), warn: m => console.error(`[fetch:warn] ${m}`) },
  },
});

await writeFile(output, JSON.stringify(packet, null, 2));
process.exit(0);
```

- [ ] **Step 2: Create a minimal manifest stub for run.sh to point at**

Create `consumers/protocol-info/manifest.json`:
```json
{
  "name": "protocol-info",
  "version": "0.5.0-wip",
  "fetchers": [
      { "name": "rootdata", "module": "./fetchers/rootdata.mjs", "required_env": ["ROOTDATA_API_KEY"], "optional": true, "search": { "enabled": true, "types": ["project", "person"], "max_queries_per_round": 4 } },
    { "name": "defillama", "module": "./fetchers/defillama.mjs", "required_env": [], "optional": true }
  ]
}
```

(Full manifest comes in phase 4 — for phase 2, only the fetchers section is used.)

- [ ] **Step 3: Modify run.sh to call dispatcher**

In `run.sh`, find the existing block that runs `preprocess-rootdata.mjs` (around the "Phase 1: Parallel execution" comment):

```bash
node "$PREPROCESS_SCRIPT" \
  --slug "$slug" \
  --display-name "$display" \
  ${rootdata_id_flag[@]+"${rootdata_id_flag[@]}"} \
  --output "$rootdata_pkt" \
  2> "$rootdata_err" &
```

Replace with:

```bash
node "$SCRIPT_DIR/framework/cli/fetch.mjs" \
  --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
  --slug "$slug" \
  --display-name "$display" \
  --hints "$hints" \
  ${rootdata_id:+--rootdata-id "$rootdata_id"} \
  --output "$rootdata_pkt" \
  2> "$rootdata_err" &
```

(File name `rootdata_pkt` becomes a misnomer — it's now a multi-fetcher packet. Don't rename yet; keep var name stable, fix in phase 9.)

- [ ] **Step 4: Smoke test**

If you have `ROOTDATA_API_KEY` set in `~/.config/protocol-info/.env`:
```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle 2>&1 | tail -20
```

Without key:
```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle 2>&1 | tail -20
```

Expected: pipeline runs to completion. Inspect:
```bash
jq 'keys' out/$(ls -1t out | head -1)/pendle/_debug/rootdata.json
```

Should show: `["defillama","fetched_at","fetcher_status","fetchers_run","rootdata"]` (or just defillama + meta if no key).

- [ ] **Step 5: Run check-all**

```bash
node scripts/check-all.mjs
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add framework/cli/fetch.mjs consumers/protocol-info/manifest.json run.sh
git commit -m "feat: route run.sh fetch through framework/cli/fetch.mjs

- run.sh now calls fetch.mjs with the consumer manifest
- evidence packet contains rootdata + defillama subtrees + fetcher_status
- preserves _debug/rootdata.json filename for backward compatibility
  (renamed properly in phase 9)"
```

---

### Task 2.6: Phase 2 verification

- [ ] **Step 1: Real-slug end-to-end**

```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle
```

Expected: completes, `record.json` produced (or schema-fails as before — that's fine, content quality unchanged in phase 2).

- [ ] **Step 2: Inspect packet shape**

```bash
OUT=$(ls -1t out | head -1)
jq '.fetchers_run, .fetcher_status' out/$OUT/pendle/_debug/rootdata.json
```

Expected: both fetchers listed; status indicates ok/skipped/failed.

- [ ] **Step 3: Verify rootdata-specific data still present**

```bash
jq '.rootdata.anchors // .rootdata.member_candidates' out/$OUT/pendle/_debug/rootdata.json
```

(If ROOTDATA_API_KEY is set.) Expected: existing rootdata fields intact under the `rootdata` subtree.

No commit — verification only.

---

# Phase 3 — R1 single-task in Node (functional equivalence)

**Deliverable:** `framework/subtask-runner.mjs` (α-shape: just slice, no findings/gaps yet); `framework/manifest-loader.mjs`; `run.sh` calls a CLI wrapper that drives the existing single big prompt through the new runner. Pipeline shape unchanged.

**Success criterion:** Same protocol crawled in phase-2 vs phase-3 produces functionally equivalent `record.json` (modulo Claude variance).

---

### Task 3.1: Write framework/manifest-loader.mjs

**Files:**
- Create: `framework/manifest-loader.mjs`
- Create: `framework/schemas/consumer-manifest.schema.json`
- Test: `tests/framework/manifest-loader.test.mjs`

- [ ] **Step 1: Write the manifest schema** (`framework/schemas/consumer-manifest.schema.json`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "framework/schemas/consumer-manifest.schema.json",
  "type": "object",
  "additionalProperties": true,
  "required": ["name", "version"],
  "properties": {
    "name":    { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "version": { "type": "string" },
    "schemas": {
      "type": "object",
      "properties": { "full": { "type": "string" } }
    },
    "fetchers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "module"],
        "properties": {
          "name":         { "type": "string" },
            "module":       { "type": "string" },
            "required_env": { "type": "array", "items": { "type": "string" } },
            "optional":     { "type": "boolean" },
            "search":       { "type": "object" },
            "description":  { "type": "string" }
        }
      }
    },
    "system_prompt": { "type": "string" },
    "subtasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "prompt", "schema_slice"],
        "properties": {
          "name":           { "type": "string" },
          "prompt":         { "type": "string" },
          "schema_slice":   { "type": "string" },
          "max_turns":      { "type": "integer", "minimum": 1 },
          "max_budget_usd": { "type": "number",  "minimum": 0 },
          "evidence_keys":  { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "reconcile": {
      "type": "object",
      "properties": {
          "enabled":      { "type": "boolean" },
          "prompt":       { "type": "string" },
          "max_turns":    { "type": "integer" },
          "max_budget_usd": { "type": "number" },
          "mode": { "type": "string", "enum": ["deep", "fast"] },
          "max_research_rounds": { "type": "integer", "minimum": 1 },
          "max_search_queries_per_round": { "type": "integer", "minimum": 0 },
          "fast_skip_allowed": { "type": "boolean" }
        }
      },
    "i18n": { "type": "object" },
    "normalizers": { "type": "array" },
    "post_processing": { "type": "array" },
    "output": { "type": "object" }
  }
}
```

- [ ] **Step 2: Write the test**

Create `tests/framework/manifest-loader.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../../framework/manifest-loader.mjs';

async function withManifest(json, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mf-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(json));
  try { return await fn(join(dir, 'manifest.json'), dir); }
  finally { await rm(dir, { recursive: true }); }
}

export const tests = [
  {
    name: 'loads minimal valid manifest',
    fn: async () => {
      await withManifest({ name: 'x', version: '0.1.0' }, async (path) => {
        const m = await loadManifest(path);
        assert.equal(m.name, 'x');
      });
    },
  },
  {
    name: 'rejects manifest with bad name',
    fn: async () => {
      await withManifest({ name: 'BAD NAME', version: '0.1.0' }, async (path) => {
        await assert.rejects(() => loadManifest(path), /name/);
      });
    },
  },
  {
    name: 'resolves all module/prompt/schema paths to absolute',
    fn: async () => {
      await withManifest({
        name: 'x', version: '0.1.0',
        fetchers: [{ name: 'a', module: './a.mjs' }],
        system_prompt: './p/sys.md',
        subtasks: [{ name: 's', prompt: './p/s.md', schema_slice: './sch/s.json' }],
      }, async (path, dir) => {
        await writeFile(join(dir, 'a.mjs'), 'export default async () => ({ ok: true })');
        await mkdir(join(dir, 'p'), { recursive: true });
        await mkdir(join(dir, 'sch'), { recursive: true });
        await writeFile(join(dir, 'p/sys.md'), 'system');
        await writeFile(join(dir, 'p/s.md'), 'prompt');
        await writeFile(join(dir, 'sch/s.json'), '{"type":"object"}');
        const m = await loadManifest(path);
        assert.equal(m._abs.fetchers[0].module_abs, join(dir, 'a.mjs'));
        assert.equal(m._abs.system_prompt, join(dir, 'p/sys.md'));
        assert.equal(m._abs.subtasks[0].prompt_abs, join(dir, 'p/s.md'));
        assert.equal(m._abs.subtasks[0].schema_slice_abs, join(dir, 'sch/s.json'));
      });
    },
  },
  {
    name: 'rejects missing referenced files',
    fn: async () => {
      await withManifest({
        name: 'x', version: '0.1.0',
        system_prompt: './missing/system.md',
      }, async (path) => {
        await assert.rejects(() => loadManifest(path), /missing referenced file/);
      });
    },
  },
];
```

- [ ] **Step 3: Run, verify fail**

```bash
node tests/run.mjs framework/manifest-loader
```

Expected: LOAD FAIL.

- [ ] **Step 4: Implement**

```js
// Reads + validates a consumer manifest. Resolves all relative paths
// (modules, prompts, schemas) to absolute; attaches under `manifest._abs`.
//
// Throws on invalid JSON, schema validation failure, or missing referenced files.

import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_SCHEMA = resolve(FRAMEWORK_DIR, 'schemas/consumer-manifest.schema.json');

function abs(base, rel) {
  if (!rel) return null;
  return isAbsolute(rel) ? rel : resolve(base, rel);
}

async function assertFile(label, path) {
  if (!path) return;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error('not a file');
  } catch (err) {
    throw new Error(`missing referenced file (${label}): ${path}`);
  }
}

export async function loadManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (e) { throw new Error(`manifest JSON parse: ${e.message}`); }

  // Validate against the manifest schema using framework/schema-validator.mjs
  const validator = resolve(FRAMEWORK_DIR, 'schema-validator.mjs');
  const r = spawnSync('node', [validator, manifestPath, '--schema', MANIFEST_SCHEMA], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`manifest schema validation failed:\n${r.stderr || r.stdout}`);
  }

  const baseDir = dirname(resolve(manifestPath));

  manifest._abs = {
    base_dir: baseDir,
    full_schema: abs(baseDir, manifest.schemas?.full),
    system_prompt: abs(baseDir, manifest.system_prompt),
    fetchers: (manifest.fetchers || []).map(f => ({
      ...f,
      module_abs: abs(baseDir, f.module),
    })),
    subtasks: (manifest.subtasks || []).map(s => ({
      ...s,
      prompt_abs: abs(baseDir, s.prompt),
      schema_slice_abs: abs(baseDir, s.schema_slice),
    })),
    reconcile_prompt: abs(baseDir, manifest.reconcile?.prompt),
    i18n: manifest.i18n ? {
      ...manifest.i18n,
      system_prompt_abs: abs(baseDir, manifest.i18n.system_prompt),
      user_prompt_abs:   abs(baseDir, manifest.i18n.user_prompt),
      schema_abs:        abs(baseDir, manifest.i18n.schema),
    } : null,
    normalizers: (manifest.normalizers || []).map(n => ({
      ...n,
      module_abs: abs(baseDir, n.module),
    })),
    post_processing: (manifest.post_processing || []).map(p => ({
      ...p,
      module_abs: abs(baseDir, p.module),
    })),
  };

  const refs = [
    ['full schema', manifest._abs.full_schema],
    ['system prompt', manifest._abs.system_prompt],
    ['reconcile prompt', manifest._abs.reconcile_prompt],
    ...(manifest._abs.fetchers || []).map(f => [`fetcher:${f.name}`, f.module_abs]),
    ...(manifest._abs.subtasks || []).flatMap(s => [
      [`subtask prompt:${s.name}`, s.prompt_abs],
      [`subtask schema:${s.name}`, s.schema_slice_abs],
    ]),
    ...(manifest._abs.normalizers || []).map(n => [`normalizer:${n.name}`, n.module_abs]),
    ...(manifest._abs.post_processing || []).map(p => [`post:${p.name}`, p.module_abs]),
  ];
  if (manifest._abs.i18n) {
    refs.push(
      ['i18n system prompt', manifest._abs.i18n.system_prompt_abs],
      ['i18n user prompt', manifest._abs.i18n.user_prompt_abs],
      ['i18n schema', manifest._abs.i18n.schema_abs],
    );
  }
  for (const [label, path] of refs) await assertFile(label, path);

  return manifest;
}
```

- [ ] **Step 5: Run, verify pass**

```bash
node tests/run.mjs framework/manifest-loader
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add framework/manifest-loader.mjs framework/schemas/consumer-manifest.schema.json tests/framework/manifest-loader.test.mjs
git commit -m "feat(framework): add manifest-loader + manifest schema"
```

---

### Task 3.2: Write framework/subtask-runner.mjs (α-shape)

**Files:**
- Create: `framework/subtask-runner.mjs`
- Test: `tests/framework/subtask-runner.test.mjs`

α-shape means: subtask returns the slice JSON directly. No `findings` / `gaps` yet — those land in phase 5.

- [ ] **Step 1: Write the test (using stub claude)**

Create `tests/framework/subtask-runner.test.mjs`:
```js
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
];
```

- [ ] **Step 2: Run, verify fail**

```bash
node tests/run.mjs framework/subtask-runner
```

Expected: LOAD FAIL.

- [ ] **Step 3: Implement (α-shape)**

```js
// Runs one subtask: render prompt → call claude → parse structured_output → return slice.
// α-shape: returns just `slice`. β-shape (slice + findings + gaps) added in phase 5.

import { runClaude } from './claude-wrapper.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));

function tryExtractFromString(s) {
  // Use json-extract.mjs as a fallback parser for noisy strings.
  const r = spawnSync('node', [join(FRAMEWORK_DIR, 'json-extract.mjs')], { input: s, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function parseEnvelope(env) {
  if (env.structured_output && typeof env.structured_output === 'object') {
    return env.structured_output;
  }
  if (typeof env.structured_output === 'string') {
    try { return JSON.parse(env.structured_output); } catch {}
    const fallback = tryExtractFromString(env.structured_output);
    if (fallback) return fallback;
  }
  if (typeof env.result === 'string') {
    const fallback = tryExtractFromString(env.result);
    if (fallback) return fallback;
  }
  return null;
}

export async function runSubtask({
  claudeBin = 'claude',
  subtask,
  systemPrompt,
  userPrompt,
  schemaSlice,
  resumeSession = null,
  model = null,
  budgetLedger = null,
}) {
  let envelope;
  try {
    envelope = await runClaude({
      claudeBin, systemPrompt, userPrompt,
      schemaJson: schemaSlice,
      maxTurns: subtask.max_turns,
      maxBudgetUsd: subtask.max_budget_usd,
      resumeSession,
      model,
      budgetLedger,
    });
  } catch (err) {
    return {
      ok: false, error: `claude invocation failed: ${err.message}`,
      cost_usd: 0, turns: 0, envelope: null,
    };
  }

  const slice = parseEnvelope(envelope);
  if (!slice) {
    return {
      ok: false, error: `no structured_output recoverable from envelope`,
      cost_usd: envelope.total_cost_usd ?? 0, turns: envelope.num_turns ?? 0,
      session_id: envelope.session_id, envelope,
    };
  }

  return {
    ok: true,
    slice,
    cost_usd: envelope.total_cost_usd ?? 0,
    turns: envelope.num_turns ?? 0,
    session_id: envelope.session_id ?? null,
    envelope,
  };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
node tests/run.mjs framework/subtask-runner
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add framework/subtask-runner.mjs tests/framework/subtask-runner.test.mjs
git commit -m "feat(framework): add subtask-runner (α-shape: slice only)"
```

---

### Task 3.3: Wire R1 through subtask-runner via a CLI shim

**Files:**
- Create: `framework/cli/r1.mjs`
- Modify: `run.sh` — replace direct `claude -p` invocation with `node framework/cli/r1.mjs`
- Modify: `consumers/protocol-info/manifest.json` — add the single-task system+user prompt

In phase 3 we keep the **single big prompt** but route it through the new Node infrastructure. Phase 4 splits it into 4.

- [ ] **Step 1: Move existing prompt files to consumer location**

```bash
mkdir -p consumers/protocol-info/prompts
git mv prompts/system.md consumers/protocol-info/prompts/system.md
git mv prompts/user.md.tmpl consumers/protocol-info/prompts/user.md.tmpl
git mv prompts/reconcile.md.tmpl consumers/protocol-info/prompts/reconcile.md.tmpl
git mv prompts/i18n.system.md consumers/protocol-info/prompts/i18n.system.md
git mv prompts/i18n.user.md.tmpl consumers/protocol-info/prompts/i18n.user.md.tmpl
```

- [ ] **Step 2: Move schemas**

```bash
mkdir -p consumers/protocol-info/schemas
git mv schema/earn-protocol-info.schema.json consumers/protocol-info/schemas/full.json
git mv schema/i18n.schema.json consumers/protocol-info/schemas/i18n.json
rmdir schema/ prompts/ 2>/dev/null || true
```

- [ ] **Step 3: Update manifest with the temporary single-subtask config**

Replace `consumers/protocol-info/manifest.json` with:

```json
{
  "name": "protocol-info",
  "version": "0.5.0-wip",
  "schemas": { "full": "./schemas/full.json" },
  "fetchers": [
      { "name": "rootdata", "module": "./fetchers/rootdata.mjs", "required_env": ["ROOTDATA_API_KEY"], "optional": true, "search": { "enabled": true, "types": ["project", "person"], "max_queries_per_round": 4 } },
    { "name": "defillama", "module": "./fetchers/defillama.mjs", "required_env": [], "optional": true }
  ],
  "system_prompt": "./prompts/system.md",
  "subtasks": [
    {
      "name": "full",
      "prompt": "./prompts/user.md.tmpl",
      "schema_slice": "./schemas/full.json",
      "max_turns": 40,
      "max_budget_usd": 2.00,
      "evidence_keys": ["rootdata", "defillama"]
    }
  ]
}
```

`subtasks: [{name:'full', schema_slice: full.json}]` is intentional — phase 3 uses the full schema as a "single slice" so we have functional equivalence with the pre-phase-3 R1.

- [ ] **Step 4: Update run.sh paths**

```bash
sed -i.bak 's|SCHEMA_FILE="$SCRIPT_DIR/schema/earn-protocol-info.schema.json"|SCHEMA_FILE="$SCRIPT_DIR/consumers/protocol-info/schemas/full.json"|' run.sh && rm run.sh.bak
sed -i.bak 's|SYSTEM_PROMPT_FILE="$SCRIPT_DIR/prompts/system.md"|SYSTEM_PROMPT_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/system.md"|' run.sh && rm run.sh.bak
sed -i.bak 's|USER_TMPL_FILE="$SCRIPT_DIR/prompts/user.md.tmpl"|USER_TMPL_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/user.md.tmpl"|' run.sh && rm run.sh.bak
sed -i.bak 's|RECONCILE_TMPL_FILE="$SCRIPT_DIR/prompts/reconcile.md.tmpl"|RECONCILE_TMPL_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/reconcile.md.tmpl"|' run.sh && rm run.sh.bak
sed -i.bak 's|I18N_SYSTEM_FILE="$SCRIPT_DIR/prompts/i18n.system.md"|I18N_SYSTEM_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/i18n.system.md"|' run.sh && rm run.sh.bak
sed -i.bak 's|I18N_TMPL_FILE="$SCRIPT_DIR/prompts/i18n.user.md.tmpl"|I18N_TMPL_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/i18n.user.md.tmpl"|' run.sh && rm run.sh.bak
sed -i.bak 's|I18N_SCHEMA_FILE="$SCRIPT_DIR/schema/i18n.schema.json"|I18N_SCHEMA_FILE="$SCRIPT_DIR/consumers/protocol-info/schemas/i18n.json"|' run.sh && rm run.sh.bak
```

- [ ] **Step 5: Smoke test paths-only change**

```bash
./run.sh --dry-run --display-name "PathCheck" --type simple_earn 2>&1 | head -20
```

Expected: rendered prompt (using the moved files), no path errors.

- [ ] **Step 6: Commit just the file moves**

```bash
git add run.sh consumers/protocol-info/
git commit -m "refactor: move prompts/ + schema/ into consumers/protocol-info/

- prompts and schemas now live under their consumer (multi-consumer prep)
- run.sh path variables updated
- functional behavior unchanged"
```

- [ ] **Step 7: Implement framework/cli/r1.mjs**

```js
// framework/cli/r1.mjs — bash-callable R1 executor.
// Reads manifest + evidence packet, renders prompt, runs subtask-runner,
// writes envelope + parsed slice to disk.
//
// In phase 3 there's a single subtask 'full'. Phase 4 will dispatch all subtasks.

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';
import { runSubtask } from '../subtask-runner.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const slug = arg('slug');
const provider = arg('provider', slug);
const displayName = arg('display-name');
const type = arg('type');
const hints = arg('hints', '');
const evidencePath = arg('evidence');
const envelopeOut = arg('envelope-out');
const sliceOut = arg('slice-out');
const claudeBin = process.env.CLAUDE_BIN || 'claude';

if (!manifestPath || !slug || !displayName || !type || !envelopeOut || !sliceOut) {
  console.error('usage: r1.mjs --manifest M --slug S --display-name D --type T [--provider P] [--hints H] --evidence E --envelope-out OUT --slice-out OUT2');
  process.exit(2);
}

const manifest = await loadManifest(manifestPath);
const subtask = manifest._abs.subtasks[0];   // phase 3: single subtask
const schemaSlice = JSON.parse(await readFile(subtask.schema_slice_abs, 'utf8'));
const systemPrompt = await readFile(manifest._abs.system_prompt, 'utf8');
const userTmpl = await readFile(subtask.prompt_abs, 'utf8');
const evidence = evidencePath ? JSON.parse(await readFile(evidencePath, 'utf8')) : {};

// Render prompt using the existing {{SLUG}}, {{DISPLAY_NAME}}, etc. placeholders.
function render(t, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), t);
}

const userPrompt = render(userTmpl, {
  SLUG: slug,
  PROVIDER: provider,
  DISPLAY_NAME: displayName,
  TYPE: type,
  HINTS: hints,
  SCHEMA: JSON.stringify(schemaSlice, null, 2),
});

const result = await runSubtask({
  claudeBin,
  subtask,
  systemPrompt,
  userPrompt,
  schemaSlice,
});

if (result.envelope) await writeFile(envelopeOut, JSON.stringify(result.envelope, null, 2));
if (result.ok) {
  await writeFile(sliceOut, JSON.stringify(result.slice, null, 2));
  console.error(`[r1] ok cost=$${result.cost_usd} turns=${result.turns} session=${result.session_id}`);
  process.exit(0);
}
console.error(`[r1] fail: ${result.error}`);
process.exit(1);
```

- [ ] **Step 8: Modify run.sh to call r1.mjs**

In `run.sh`, find the existing R1 invocation block (the `claude -p -` block with `--json-schema "$SCHEMA_INLINE"`). Replace with:

```bash
node "$SCRIPT_DIR/framework/cli/r1.mjs" \
  --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
  --slug "$slug" \
  --provider "$provider" \
  --display-name "$display" \
  --type "$type" \
  --hints "$hints" \
  --evidence "$rootdata_pkt" \
  --envelope-out "$r1_env" \
  --slice-out "$rec" \
  > /dev/null 2> "$r1_err" &
pid_claude=$!
```

(Background-process semantics preserved; existing wait + parse logic continues to work because we still write `$r1_env` envelope.)

The downstream parsing code in run.sh that does `jq '.structured_output'` on `$r1_env` to extract → `$rec` is now redundant (r1.mjs already writes `$rec`). Remove that block. Or leave it (it's idempotent — parsing already-parsed JSON works). For clarity, remove.

- [ ] **Step 9: Real-slug smoke test**

```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle
```

Expected: pipeline completes, `out/<ts>/pendle/record.json` produced.

Compare against a phase-2 baseline run if available — fields should be substantially equivalent.

- [ ] **Step 10: Run check-all**

```bash
node scripts/check-all.mjs
```

- [ ] **Step 11: Commit**

```bash
git add framework/cli/r1.mjs run.sh consumers/protocol-info/manifest.json
git commit -m "feat: route R1 through framework/cli/r1.mjs (single-subtask 'full')

- subtask-runner drives the existing single big prompt
- functional equivalence vs phase-2: same prompt, same schema, same output
- prepares the seam for phase-4 fan-out"
```

---

# Phase 4 — Fan-out (4 subtasks)

**Deliverable:** 4 slice schemas, 4 prompt templates, `framework/merger.mjs`, manifest declaring 4 subtasks. R1 runs them in parallel via parallel-runner; merger combines slices into the full record.

**Smoke test:** real-slug run produces a record where each subtask owned its own field group, fill-rate ≥ phase-3 baseline.

**Risk note:** This phase has the highest prompt-quality risk. Plan a dogfood-loop on at least 3 known protocols before committing.

---

### Task 4.1: Author the 4 slice schemas

**Files:**
- Create: `consumers/protocol-info/schemas/metadata.slice.json`
- Create: `consumers/protocol-info/schemas/team.slice.json`
- Create: `consumers/protocol-info/schemas/funding.slice.json`
- Create: `consumers/protocol-info/schemas/audits.slice.json`

Each slice is a strict subset of `full.json`. Field definitions are copied verbatim from `full.json`. Don't introduce $ref.

- [ ] **Step 1: Create `metadata.slice.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "consumers/protocol-info/schemas/metadata.slice.json",
  "title": "EarnProtocolInfo metadata slice",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "slug", "provider", "displayName", "type",
    "description", "tags", "establishment",
    "providerWebsite", "providerXLink", "providerDiscordLink",
    "status"
  ],
  "properties": {
    "slug":        { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,63}$" },
    "provider":    { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{0,63}$" },
    "displayName": { "type": "string", "minLength": 1, "maxLength": 80 },
    "type":        { "type": "string", "enum": ["fixed_rate", "simple_earn", "staking"] },
    "description": { "type": ["string", "null"], "maxLength": 1000 },
    "tags":        { "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 32 }, "minItems": 1, "maxItems": 20 },
    "establishment": { "type": "integer", "minimum": 1900, "maximum": 2030 },
    "providerWebsite":     { "type": "string", "format": "uri", "maxLength": 500 },
    "providerXLink":       { "type": "string", "format": "uri", "maxLength": 500 },
    "providerDiscordLink": { "type": ["string", "null"], "format": "uri", "maxLength": 500 },
    "status": { "type": "string", "enum": ["draft", "active", "archived"] }
  }
}
```

- [ ] **Step 2: Create `team.slice.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "consumers/protocol-info/schemas/team.slice.json",
  "title": "EarnProtocolInfo team slice",
  "type": "object",
  "additionalProperties": false,
  "required": ["members"],
  "properties": {
    "members": {
      "type": "array",
      "minItems": 1,
      "maxItems": 30,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["memberName", "memberPosition", "oneLiner", "avatarUrl", "memberLink"],
        "properties": {
          "memberName":     { "type": "string", "minLength": 1, "maxLength": 80 },
          "memberPosition": { "type": "string", "maxLength": 80 },
          "oneLiner":       { "type": ["string", "null"], "maxLength": 140 },
          "avatarUrl":      { "type": ["string", "null"], "format": "uri", "maxLength": 500 },
          "memberLink": {
            "type": "object",
            "additionalProperties": false,
            "required": ["xLink", "linkedinLink"],
            "properties": {
              "xLink":        { "type": ["string", "null"], "format": "uri", "maxLength": 500 },
              "linkedinLink": { "type": ["string", "null"], "format": "uri", "maxLength": 500 }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Create `funding.slice.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "consumers/protocol-info/schemas/funding.slice.json",
  "title": "EarnProtocolInfo funding slice",
  "type": "object",
  "additionalProperties": false,
  "required": ["fundingRounds"],
  "properties": {
    "fundingRounds": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["round", "date", "amount", "valuation", "investors"],
        "properties": {
          "round":     { "type": "string", "minLength": 1, "maxLength": 80 },
          "date":      { "type": "string", "pattern": "^\\d{4}-\\d{2}(-\\d{2})?$" },
          "amount":    { "type": ["string", "null"], "maxLength": 32 },
          "valuation": { "type": ["string", "null"], "maxLength": 32 },
          "investors": { "type": "array", "maxItems": 50, "items": { "type": "string", "minLength": 1, "maxLength": 120 } }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create `audits.slice.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "consumers/protocol-info/schemas/audits.slice.json",
  "title": "EarnProtocolInfo audits slice",
  "type": "object",
  "additionalProperties": false,
  "required": ["audits"],
  "properties": {
    "audits": {
      "type": "object",
      "additionalProperties": false,
      "required": ["items", "lastScannedAt"],
      "properties": {
        "items": {
          "type": "array",
          "maxItems": 30,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["auditor", "auditorLogoUrl", "date", "scope", "reportUrl"],
            "properties": {
              "auditor":        { "type": "string", "minLength": 1, "maxLength": 120 },
              "auditorLogoUrl": { "type": ["string", "null"], "format": "uri", "maxLength": 500 },
              "date":           { "type": "string", "pattern": "^\\d{4}-\\d{2}(-\\d{2})?$" },
              "scope":          { "type": ["string", "null"], "maxLength": 200 },
              "reportUrl":      { "type": ["string", "null"], "format": "uri", "maxLength": 500 }
            }
          }
        },
        "lastScannedAt": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
      }
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add consumers/protocol-info/schemas/{metadata,team,funding,audits}.slice.json
git commit -m "feat(consumer): add 4 slice schemas (metadata/team/funding/audits)"
```

---

### Task 4.2: Slice-coherence check script

**Files:**
- Create: `scripts/check-slice-coherence.mjs`
- Modify: `scripts/check-all.mjs` to include it

- [ ] **Step 1: Implement check-slice-coherence**

```js
#!/usr/bin/env node
// Verifies each slice schema's properties are a strict subset of full.json's properties,
// and that each property's validation semantics match.
//
// This catches drift when full.json is updated but a slice is forgotten.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FULL = resolve(ROOT, 'consumers/protocol-info/schemas/full.json');
const SLICES = [
  'metadata.slice.json',
  'team.slice.json',
  'funding.slice.json',
  'audits.slice.json',
].map(f => resolve(ROOT, 'consumers/protocol-info/schemas', f));

const fullSchema = JSON.parse(await readFile(FULL, 'utf8'));
const fullProps = fullSchema.properties || {};
let problems = 0;

const ANNOTATION_KEYS = new Set(['$schema', '$id', 'title', 'description', 'examples', 'default']);
function canonicalValidationShape(node) {
  if (Array.isArray(node)) return node.map(canonicalValidationShape);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (ANNOTATION_KEYS.has(key)) continue;
    out[key] = canonicalValidationShape(node[key]);
  }
  return out;
}

for (const slicePath of SLICES) {
  const slice = JSON.parse(await readFile(slicePath, 'utf8'));
  const props = slice.properties || {};
  for (const [k, v] of Object.entries(props)) {
    if (!(k in fullProps)) {
      console.error(`✗ ${slicePath}: property "${k}" not in full.json`);
      problems++;
      continue;
    }
    const a = JSON.stringify(canonicalValidationShape(v));
    const b = JSON.stringify(canonicalValidationShape(fullProps[k]));
    if (a !== b) {
      console.error(`✗ ${slicePath}: property "${k}" validation semantics diverge from full.json`);
      problems++;
    }
  }
  // Required check
  for (const r of (slice.required || [])) {
    if (!(r in fullProps)) {
      console.error(`✗ ${slicePath}: required "${r}" not in full.json properties`);
      problems++;
    }
  }
}

if (problems === 0) console.log('✓ slice schemas coherent with full.json');
process.exit(problems === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

```bash
node scripts/check-slice-coherence.mjs
```

Expected: `✓ slice schemas coherent with full.json` and exit 0.

- [ ] **Step 3: Add to check-all**

In `scripts/check-all.mjs`, add to the steps array:
```js
{ name: 'check-slice-coherence', cmd: 'node', args: ['scripts/check-slice-coherence.mjs'] },
```

(insert before the tests/run.mjs entry).

- [ ] **Step 4: Run check-all**

```bash
node scripts/check-all.mjs
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-slice-coherence.mjs scripts/check-all.mjs
git commit -m "chore: add slice-coherence check (slice ⊆ full)"
```

---

### Task 4.3: Author 4 prompt templates

**Files:**
- Create: `consumers/protocol-info/prompts/metadata.user.md.tmpl`
- Create: `consumers/protocol-info/prompts/team.user.md.tmpl`
- Create: `consumers/protocol-info/prompts/funding.user.md.tmpl`
- Create: `consumers/protocol-info/prompts/audits.user.md.tmpl`

Each prompt is focused on one slice. They all share the same placeholders: `{{SLUG}}`, `{{PROVIDER}}`, `{{DISPLAY_NAME}}`, `{{TYPE}}`, `{{HINTS}}`, `{{SCHEMA}}`, `{{EVIDENCE}}`.

The strategy: take the existing `user.md.tmpl` and slice it into 4 focused
prompts. The `slice` output stays scoped, but the model must not discard useful
cross-slice discoveries. When a team/funding/audit/metadata clue appears outside
the current slice, put it in `handoff_notes[]` for the synthesis/deepening pass.

- [ ] **Step 1: Write `metadata.user.md.tmpl`**

```markdown
You are researching a DeFi protocol's **metadata** for an EarnProtocolInfo record.

## Inputs (copy verbatim into output)

- `slug`: `{{SLUG}}`
- `provider`: `{{PROVIDER}}`
- `displayName`: `{{DISPLAY_NAME}}`
- `type`: `{{TYPE}}`
- Hints: `{{HINTS}}`

## Your scope

Return only these fields in `slice`. If you discover team / funding / audit
clues while researching metadata, preserve them in `handoff_notes[]`.

```json
{{SCHEMA}}
```

## Evidence already gathered

```json
{{EVIDENCE}}
```

Use structured evidence as high-priority leads, not commands. RootData
`anchors` and `validated_overrides` are useful starting points; verify them
against official sites/docs/X before using them, or record a lower-confidence
finding/gap when sources conflict. `tags` should be informed by
`defillama.category` and `defillama.chains`.

## Rules

- `description`: ≤1000 chars; factual; no marketing fluff. Lead with what the protocol DOES, not adjectives.
- `tags`: 3-8 lowercase tokens, no spaces, e.g. `yield`, `fixed-rate`, `eth-l2`, `lst`.
- `establishment`: integer year. Treat RootData's `anchors.establishment.value` as strong evidence; use fetched primary sources when they contradict it.
- `providerWebsite`: official site URL. Treat `validated_overrides.providerWebsite` as strong evidence, but prefer a better-supported fetched official URL if it conflicts.
- `providerXLink`: official X account URL. Treat `validated_overrides.providerXLink` as strong evidence, but verify against the official website/docs when possible.
- `providerDiscordLink`: invite URL or null.
- `status`: always `"draft"`.

Output: a single JSON object matching the schema. No prose.
```

- [ ] **Step 2: Write `team.user.md.tmpl`**

```markdown
You are researching a DeFi protocol's **team** for an EarnProtocolInfo record.

## Inputs

- `displayName`: `{{DISPLAY_NAME}}`
- Hints: `{{HINTS}}`

## Your scope

Return only `members` in `slice`. If team research reveals funding,
metadata, or audit clues, preserve them in `handoff_notes[]`.

```json
{{SCHEMA}}
```

## Evidence (member candidates already scored)

```json
{{EVIDENCE}}
```

Bucket key: `rootdata.member_candidates`. Each candidate has a `bucket` field (`likely_member`, `review`, or other) — start with `likely_member`, verify each via X bio + LinkedIn.

## Rules

- 1–8 verified members; founders/leadership prioritized.
- `memberName`: full real name. Reject pseudonyms unless they're the public identity (e.g., `0xMaki`).
- `memberPosition`: brief title (`CEO`, `Co-Founder`, `Head of Engineering`).
- `oneLiner`: ≤140 chars on prior notable experience. Null only when nothing verifiable.
- `avatarUrl`: prefer `https://unavatar.io/x/<handle>?fallback=false`; null if no public avatar.
- `memberLink.xLink`: full URL `https://x.com/<handle>` or null.
- `memberLink.linkedinLink`: full LinkedIn profile URL or null.
- Cross-check: a candidate appearing in rootdata + X bio confirming the role + LinkedIn matching = include. Less than 2 of these = exclude or note in `oneLiner` as `Unverified`.

Output: a single JSON object `{"members": [...]}`. No prose.
```

- [ ] **Step 3: Write `funding.user.md.tmpl`**

```markdown
You are researching a DeFi protocol's **funding history** for an EarnProtocolInfo record.

## Inputs

- `displayName`: `{{DISPLAY_NAME}}`

## Your scope

Return only `fundingRounds` in `slice`. If funding research reveals team,
metadata, or audit clues, preserve them in `handoff_notes[]`.

```json
{{SCHEMA}}
```

## Evidence

```json
{{EVIDENCE}}
```

Treat `rootdata.api_funding` as a strong lead, not ground truth. Cross-check via
Crunchbase, the protocol's own announcements, and announcement-style press
(TechCrunch, The Block).

## Rules

- **Full history, newest first.** If the protocol raised Series B, Seed and Series A MUST also be present.
- `round`: `Seed`, `Pre-Seed`, `Series A`, `Series B`, `Strategic`, `Private`, `Public`, `Grant`, etc.
- `date`: `YYYY-MM-DD` if exact day known, else `YYYY-MM`.
- `amount`: display string with currency, e.g. `$5M`, `$165M`, `$11M`. Null if undisclosed.
- `valuation`: e.g. `$1.66B`. Null if undisclosed.
- `investors`: array of firms/angels for that round. Empty array if undisclosed.
- Use the `rootdata.api_funding.investors_orgs_normalized` list as a reference for canonical investor names when supported by fetched evidence.

Output: `{"fundingRounds": [...]}`. No prose.
```

- [ ] **Step 4: Write `audits.user.md.tmpl`**

```markdown
You are researching a DeFi protocol's **security audits** for an EarnProtocolInfo record.

## Inputs

- `displayName`: `{{DISPLAY_NAME}}`

## Your scope

Return only `audits` in `slice`. If audit research reveals metadata, team, or
funding clues, preserve them in `handoff_notes[]`.

```json
{{SCHEMA}}
```

## Strategy

The protocol's docs site usually links to audit reports. Common locations:
- `<docs site>/security` or `<docs site>/audits` page
- `<protocol>/audits` GitHub repo (e.g., `pendle-finance/audits`)
- Audit firm's own publication site (Trail of Bits, OpenZeppelin, Spearbit, Certora, ChainSecurity)

Use WebSearch to find the audit page; follow links into the GitHub repo if needed; download/inspect PDFs for date and scope.

## Rules

- One entry per distinct audit report, newest first.
- `auditor`: firm name, e.g. `Certora`, `Trail of Bits`, `OpenZeppelin`, `Spearbit`, `ChainSecurity`, `Quantstamp`.
- `auditorLogoUrl`: prefer the firm's official logo URL, else null.
- `date`: report date — `YYYY-MM-DD` or `YYYY-MM`.
- `scope`: brief description (`Core contracts`, `vePENDLE`, `LP token wrapper`). Null if unknown.
- `reportUrl`: direct PDF or blog post URL.
- `lastScannedAt`: leave any `YYYY-MM-DD`; will be overwritten by the runner.

If you genuinely find no audits, return `{"audits": {"items": [], "lastScannedAt": "1970-01-01"}}`. Do not invent.

Output: `{"audits": {...}}`. No prose.
```

- [ ] **Step 5: Commit**

```bash
git add consumers/protocol-info/prompts/{metadata,team,funding,audits}.user.md.tmpl
git commit -m "feat(consumer): add 4 subtask prompt templates"
```

---

### Task 4.4: Implement framework/merger.mjs (α-shape: slices only)

**Files:**
- Create: `framework/merger.mjs`
- Test: `tests/framework/merger.test.mjs`

α-merger only combines slices — findings/gaps merger comes in phase 5.

- [ ] **Step 1: Write the test**

Create `tests/framework/merger.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { mergeSlices } from '../../framework/merger.mjs';

export const tests = [
  {
    name: 'merges 4 disjoint slices',
    fn: async () => {
      const result = mergeSlices([
        { name: 'metadata', ok: true, slice: { slug: 's', displayName: 'S', type: 'staking' } },
        { name: 'team', ok: true, slice: { members: [{memberName: 'A'}] } },
        { name: 'funding', ok: true, slice: { fundingRounds: [{round: 'Seed'}] } },
        { name: 'audits', ok: true, slice: { audits: { items: [], lastScannedAt: '2026-01-01' } } },
      ]);
      assert.equal(result.record.slug, 's');
      assert.equal(result.record.members.length, 1);
      assert.equal(result.record.fundingRounds.length, 1);
      assert.equal(result.record.audits.lastScannedAt, '2026-01-01');
      assert.deepEqual(result.failed_subtasks, []);
    },
  },
  {
    name: 'records failed subtask + falls back to {} for its slice',
    fn: async () => {
      const result = mergeSlices([
        { name: 'metadata', ok: true, slice: { slug: 's' } },
        { name: 'team', ok: false, error: 'boom' },
      ]);
      assert.equal(result.record.slug, 's');
      assert.equal('members' in result.record, false);
      assert.deepEqual(result.failed_subtasks, [{ name: 'team', reason: 'boom' }]);
    },
  },
  {
    name: 'collides on overlapping field — last writer wins, but warns',
    fn: async () => {
      let warned = false;
      const result = mergeSlices([
        { name: 'a', ok: true, slice: { x: 1 } },
        { name: 'b', ok: true, slice: { x: 2 } },
      ], { onCollision: () => { warned = true; } });
      assert.equal(result.record.x, 2);
      assert.equal(warned, true);
    },
  },
];
```

- [ ] **Step 2: Run, verify fails**

```bash
node tests/run.mjs framework/merger
```

Expected: LOAD FAIL.

- [ ] **Step 3: Implement**

```js
// Merges N subtask outputs into a single record + failure log.
// α-shape: handles slices only. β-shape (findings/gaps accumulation +
// audit-first R2 guard) extends this in phases 5–6.

export function mergeSlices(subtaskResults, opts = {}) {
  const onCollision = opts.onCollision || ((field, by, prev) => {
    console.error(`[merger] collision on field "${field}": "${by}" overwrites "${prev}"`);
  });

  const record = {};
  const failed_subtasks = [];
  const field_owner = {};   // field name → subtask name (for collision warnings)

  for (const r of subtaskResults) {
    if (!r.ok) {
      failed_subtasks.push({ name: r.name, reason: r.error || 'unknown' });
      continue;
    }
    if (!r.slice || typeof r.slice !== 'object') continue;
    for (const [k, v] of Object.entries(r.slice)) {
      if (k in record) onCollision(k, r.name, field_owner[k]);
      record[k] = v;
      field_owner[k] = r.name;
    }
  }

  return { record, failed_subtasks, field_owner };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
node tests/run.mjs framework/merger
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add framework/merger.mjs tests/framework/merger.test.mjs
git commit -m "feat(framework): add merger (α-shape: slice merge + failure tracking)"
```

---

### Task 4.5: Update r1.mjs to fan-out

**Files:**
- Modify: `framework/cli/r1.mjs`
- Modify: `consumers/protocol-info/manifest.json` — replace single `full` subtask with 4 real subtasks
- Modify: `run.sh` only if invocation interface needs adjustment (it shouldn't)

- [ ] **Step 1: Update the manifest**

Replace `consumers/protocol-info/manifest.json`'s `subtasks` array:

```json
"subtasks": [
  {
    "name": "metadata",
    "prompt": "./prompts/metadata.user.md.tmpl",
    "schema_slice": "./schemas/metadata.slice.json",
    "max_turns": 15,
    "max_budget_usd": 0.50,
    "evidence_keys": ["rootdata.anchors", "rootdata.validated_overrides", "defillama.category", "defillama.chains"]
  },
  {
    "name": "team",
    "prompt": "./prompts/team.user.md.tmpl",
    "schema_slice": "./schemas/team.slice.json",
    "max_turns": 25,
    "max_budget_usd": 0.80,
    "evidence_keys": ["rootdata.member_candidates"]
  },
  {
    "name": "funding",
    "prompt": "./prompts/funding.user.md.tmpl",
    "schema_slice": "./schemas/funding.slice.json",
    "max_turns": 15,
    "max_budget_usd": 0.50,
    "evidence_keys": ["rootdata.api_funding"]
  },
  {
    "name": "audits",
    "prompt": "./prompts/audits.user.md.tmpl",
    "schema_slice": "./schemas/audits.slice.json",
    "max_turns": 20,
    "max_budget_usd": 0.50,
    "evidence_keys": []
  }
]
```

- [ ] **Step 2: Add evidence-keys path extractor helper**

Append to `framework/manifest-loader.mjs`:

```js
// Extract a subtree of the evidence packet by jq-style path keys.
// `keys`: array of dot-paths, e.g. ["rootdata.anchors", "defillama.category"]
// Returns an object { rootdata: { anchors: ... }, defillama: { category: ... } }
export function selectEvidence(packet, keys) {
  const out = {};
  for (const path of keys) {
    const parts = path.split('.');
    let src = packet;
    let dst = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!src || typeof src !== 'object' || !(p in src)) { src = null; break; }
      src = src[p];
      if (!(p in dst)) dst[p] = {};
      dst = dst[p];
    }
    if (src && typeof src === 'object') {
      const last = parts[parts.length - 1];
      if (last in src) dst[last] = src[last];
    }
  }
  return out;
}
```

- [ ] **Step 3: Add a test for `selectEvidence`**

Append to `tests/framework/manifest-loader.test.mjs`:
```js
import { selectEvidence } from '../../framework/manifest-loader.mjs';

tests.push({
  name: 'selectEvidence picks subtree by dot-path',
  fn: async () => {
    const packet = { rootdata: { anchors: { x: 1 }, members: [] }, defillama: { tvl: 100 } };
    const out = selectEvidence(packet, ['rootdata.anchors', 'defillama.tvl']);
    assert.deepEqual(out, { rootdata: { anchors: { x: 1 } }, defillama: { tvl: 100 } });
  },
});

tests.push({
  name: 'selectEvidence skips missing paths silently',
  fn: async () => {
    const out = selectEvidence({ a: 1 }, ['x.y.z']);
    assert.deepEqual(out, {});
  },
});
```

- [ ] **Step 4: Rewrite r1.mjs to fan out**

Replace `framework/cli/r1.mjs` with:

```js
// framework/cli/r1.mjs — fan-out R1 executor.
// For each subtask in manifest:
//   - extract relevant evidence subtree
//   - render prompt
//   - call subtask-runner
//   - collect {slice, ok, error, cost, turns, session_id, envelope}
// Then merge slices via merger.mjs and write record + per-subtask envelopes.

import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadManifest, selectEvidence } from '../manifest-loader.mjs';
import { runSubtask } from '../subtask-runner.mjs';
import { mergeSlices } from '../merger.mjs';
import { runWithLimit } from '../parallel-runner.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const slug = arg('slug');
const provider = arg('provider', slug);
const displayName = arg('display-name');
const type = arg('type');
const hints = arg('hints', '');
const evidencePath = arg('evidence');
const recordOut = arg('record-out');
const debugDir = arg('debug-dir');           // _debug/r1/
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const concurrency = parseInt(arg('concurrency', '4'), 10);

if (!manifestPath || !slug || !displayName || !type || !recordOut || !debugDir) {
  console.error('usage: r1.mjs --manifest M --slug S --display-name D --type T [--provider P] [--hints H] --evidence E --record-out R --debug-dir D2');
  process.exit(2);
}

await mkdir(debugDir, { recursive: true });

const manifest = await loadManifest(manifestPath);
const systemPrompt = await readFile(manifest._abs.system_prompt, 'utf8');
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));

function render(t, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), t);
}

const tasks = manifest._abs.subtasks.map(st => async () => {
  const slice = JSON.parse(await readFile(st.schema_slice_abs, 'utf8'));
  const userTmpl = await readFile(st.prompt_abs, 'utf8');
  const evSubset = selectEvidence(evidence, st.evidence_keys || []);
  const userPrompt = render(userTmpl, {
    SLUG: slug, PROVIDER: provider, DISPLAY_NAME: displayName,
    TYPE: type, HINTS: hints,
    SCHEMA: JSON.stringify(slice, null, 2),
    EVIDENCE: JSON.stringify(evSubset, null, 2),
  });

  console.error(`[r1:${st.name}] starting (max_budget=$${st.max_budget_usd} max_turns=${st.max_turns})`);
  const r = await runSubtask({
    claudeBin, subtask: st, systemPrompt, userPrompt, schemaSlice: slice,
  });

  if (r.envelope) {
    await writeFile(join(debugDir, `${st.name}.envelope.json`), JSON.stringify(r.envelope, null, 2));
  }

  return { name: st.name, ...r };
});

const results = await runWithLimit(concurrency, tasks);
const merge = mergeSlices(results);

await writeFile(recordOut, JSON.stringify(merge.record, null, 2));

console.error(`[r1] done — ${results.filter(r => r.ok).length}/${results.length} subtasks ok`);
if (merge.failed_subtasks.length > 0) {
  console.error(`[r1] failed: ${merge.failed_subtasks.map(f => `${f.name} (${f.reason})`).join(', ')}`);
}

const status = {
  subtasks: results.map(r => ({ name: r.name, ok: r.ok, cost_usd: r.cost_usd, turns: r.turns, session_id: r.session_id, error: r.error || null })),
  failed_subtasks: merge.failed_subtasks,
};
await writeFile(join(debugDir, 'r1-status.json'), JSON.stringify(status, null, 2));

process.exit(merge.failed_subtasks.length === results.length ? 1 : 0);  // exit fail only if 0/N succeeded
```

- [ ] **Step 5: Update run.sh to use new arguments**

In `run.sh`, replace the existing r1.mjs invocation (from phase 3) with:

```bash
node "$SCRIPT_DIR/framework/cli/r1.mjs" \
  --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
  --slug "$slug" \
  --provider "$provider" \
  --display-name "$display" \
  --type "$type" \
  --hints "$hints" \
  --evidence "$rootdata_pkt" \
  --record-out "$rec" \
  --debug-dir "$debug_dir/r1" \
  > /dev/null 2> "$r1_err" &
pid_claude=$!
```

The legacy `$r1_env` variable now points at multiple per-subtask envelopes under `_debug/r1/`. Update any subsequent run.sh logic that references `$r1_env`:
- Anywhere `jq '.session_id' "$r1_env"` is read, change to read from the metadata subtask's envelope: `jq '.session_id' "$debug_dir/r1/metadata.envelope.json"` (use metadata's session as the canonical R1 session for R2 resume).
- The variable `r1_env` can be repurposed: `r1_env="$debug_dir/r1/metadata.envelope.json"` for the legacy code path.

- [ ] **Step 6: Real-slug smoke test**

```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle
OUT=$(ls -1t out | head -1)
ls out/$OUT/pendle/_debug/r1/
```

Expected: 4 envelope files (`metadata.envelope.json`, `team.envelope.json`, `funding.envelope.json`, `audits.envelope.json`) + `r1-status.json`.

```bash
jq 'keys' out/$OUT/pendle/record.json
```

Expected: keys cover all of metadata + team + funding + audits.

- [ ] **Step 7: Compare field fill rate vs phase-3 baseline**

If you saved a phase-3 `record.json`, compare:
```bash
jq '. | {description: (.description != null and .description != ""), members: (.members | length // 0), fundingRounds: (.fundingRounds | length // 0), audits: (.audits.items | length // 0)}' out/$OUT/pendle/record.json
```

Expected: equal or better fill counts than phase-3 single-prompt run.

- [ ] **Step 8: Run check-all**

```bash
node scripts/check-all.mjs
```

Expected: green.

- [ ] **Step 9: Commit**

```bash
git add framework/cli/r1.mjs framework/manifest-loader.mjs consumers/protocol-info/manifest.json run.sh tests/framework/manifest-loader.test.mjs
git commit -m "feat: R1 fan-out via 4 parallel subtasks

- manifest declares 4 subtasks (metadata/team/funding/audits)
- r1.mjs dispatches each with its slice + relevant evidence subtree
- mergeSlices combines into a record; failed subtasks listed in r1-status.json
- per-subtask envelopes written to _debug/r1/<subtask>.envelope.json
- functional shape change: R1 now fans out (4× parallel claude calls)"
```

---

# Phase 5 — β output (findings + gaps)

**Deliverable:** Universal `findings.schema.json`, `changes.schema.json`, and `gaps.schema.json`. Subtasks return `{slice, findings, gaps, handoff_notes}`. Merger accumulates findings/gaps/handoffs and tags them with stage/subtask. R2 later uses `changes[]` for audited model-driven edits. New artifacts in this phase: `findings.json`, `gaps.json`, `handoff_notes.json` per slug; `changes.json` lands when R2 is wired in Phase 6.

**Success criterion:** `findings.json` contains plausible per-field provenance with confidence scores; `gaps.json` lists fields Claude couldn't fill with reasons; `handoff_notes.json` preserves useful cross-slice clues.

---

### Task 5.1: Author findings + gaps schemas

**Files:**
- Create: `framework/schemas/findings.schema.json`
- Create: `framework/schemas/changes.schema.json`
- Create: `framework/schemas/gaps.schema.json`

- [ ] **Step 1: Write `findings.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "framework/schemas/findings.schema.json",
  "type": "array",
  "maxItems": 200,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["field", "value", "source", "confidence"],
    "properties": {
      "field":      { "type": "string", "minLength": 1, "maxLength": 200 },
      "entity_key": { "type": "string", "minLength": 1, "maxLength": 200 },
      "value":      {},
      "source":     { "type": "string", "format": "uri", "maxLength": 500 },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
      "method":     { "type": "string", "maxLength": 200 },
      "supporting_sources": {
        "type": "array",
        "maxItems": 5,
        "items": { "type": "string", "format": "uri", "maxLength": 500 }
      }
    }
  }
}
```

- [ ] **Step 2: Write `changes.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "framework/schemas/changes.schema.json",
  "type": "array",
  "maxItems": 200,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["field", "before", "after", "reason", "confidence"],
    "properties": {
      "field":      { "type": "string", "minLength": 1, "maxLength": 200 },
      "entity_key": { "type": "string", "minLength": 1, "maxLength": 200 },
      "before":     {},
      "after":      {},
      "reason":     { "type": "string", "minLength": 1, "maxLength": 500 },
      "source":     { "type": "string", "maxLength": 500 },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
    }
  }
}
```

- [ ] **Step 3: Write `gaps.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "framework/schemas/gaps.schema.json",
  "type": "array",
  "maxItems": 100,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["field", "reason"],
    "properties": {
      "field":  { "type": "string", "minLength": 1, "maxLength": 200 },
      "reason": { "type": "string", "minLength": 1, "maxLength": 500 },
      "tried": {
        "type": "array",
        "maxItems": 10,
        "items": { "type": "string", "maxLength": 200 }
      }
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add framework/schemas/findings.schema.json framework/schemas/changes.schema.json framework/schemas/gaps.schema.json
git commit -m "feat(framework): add universal findings/changes/gaps schemas"
```

---

### Task 5.2: Build union schema in subtask-runner

**Files:**
- Modify: `framework/subtask-runner.mjs`
- Modify: `tests/framework/subtask-runner.test.mjs`

- [ ] **Step 1: Update the test to expect β-shape**

Append to `tests/framework/subtask-runner.test.mjs`:
```js
tests.push({
  name: 'returns slice + findings + gaps in β-shape',
  fn: async () => {
    const env = JSON.stringify({
      session_id: 's', total_cost_usd: 0.05, num_turns: 3,
        structured_output: {
          slice: { members: [{ memberName: 'A' }] },
          findings: [{ field: 'members[0].memberName', value: 'A', source: 'https://x.com/a', confidence: 0.9 }],
          gaps: [],
          handoff_notes: [{ target: 'funding', note: 'A appears in seed announcement', source: 'https://example.com/seed' }]
        }
    });
    await withStubClaude(env, async (claudeBin) => {
      const result = await runSubtask({
        claudeBin,
        subtask: { name: 'team', max_turns: 5, max_budget_usd: 0.5 },
        systemPrompt: '', userPrompt: 'x',
        schemaSlice: { type: 'object' },
        findingsSchema: {},
        gapsSchema: {},
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.slice, { members: [{ memberName: 'A' }] });
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].confidence, 0.9);
        assert.deepEqual(result.gaps, []);
        assert.equal(result.handoff_notes.length, 1);
      });
    },
  });
```

- [ ] **Step 2: Update implementation**

Modify `framework/subtask-runner.mjs`. Add new parameters and union-schema construction:

```js
// Insert before runSubtask:
function buildUnionSchema(outputKey, payloadSchema, findingsSchema, gapsSchema, changesSchema = null) {
    const required = [outputKey, 'findings', 'gaps'];
    const properties = {
      [outputKey]: payloadSchema,
      findings: findingsSchema,
      gaps: gapsSchema,
      handoff_notes: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'note'],
          properties: {
            target: { type: 'string', maxLength: 80 },
            note: { type: 'string', minLength: 1, maxLength: 500 },
            source: { type: 'string', maxLength: 500 },
          },
        },
      },
      search_requests: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['channel', 'query', 'reason'],
          properties: {
            channel: { type: 'string', enum: ['rootdata'] },
            type: { type: 'string', enum: ['project', 'person'] },
            query: { type: 'string', minLength: 2, maxLength: 200 },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            limit: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
      },
    };
  if (changesSchema) {
    required.splice(2, 0, 'changes');
    properties.changes = changesSchema;
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}
```

In `runSubtask`'s parameters add `findingsSchema`, `gapsSchema`, optional
`changesSchema`, and optional `outputKey = 'slice'` (default keeps R1 behavior).
When findings+gaps are provided, run with the union schema; otherwise fall back
to α-shape (just `schemaSlice`). R2 uses `outputKey: 'record'` plus
`changesSchema`.

```js
export async function runSubtask({
  claudeBin = 'claude',
  subtask,
  systemPrompt,
  userPrompt,
  schemaSlice,
  findingsSchema = null,
  gapsSchema = null,
  changesSchema = null,
  outputKey = 'slice',
  resumeSession = null,
  model = null,
}) {
  const useBeta = findingsSchema && gapsSchema;
  const schemaJson = useBeta
    ? buildUnionSchema(outputKey, schemaSlice, findingsSchema, gapsSchema, changesSchema)
    : schemaSlice;

  let envelope;
  try {
    envelope = await runClaude({
      claudeBin, systemPrompt, userPrompt, schemaJson,
      maxTurns: subtask.max_turns,
      maxBudgetUsd: subtask.max_budget_usd,
      resumeSession, model,
    });
  } catch (err) {
    return {
      ok: false, error: `claude invocation failed: ${err.message}`,
      cost_usd: 0, turns: 0, envelope: null,
    };
  }

  const parsed = parseEnvelope(envelope);
  if (!parsed) {
    return {
      ok: false, error: 'no structured_output recoverable',
      cost_usd: envelope.total_cost_usd ?? 0, turns: envelope.num_turns ?? 0,
      session_id: envelope.session_id, envelope,
    };
  }

  if (useBeta) {
    if (!parsed[outputKey] || !Array.isArray(parsed.findings) || !Array.isArray(parsed.gaps)) {
      return {
        ok: false, error: `β output missing ${outputKey}/findings/gaps`,
        cost_usd: envelope.total_cost_usd ?? 0, turns: envelope.num_turns ?? 0,
        session_id: envelope.session_id, envelope,
      };
    }
    if (changesSchema && !Array.isArray(parsed.changes)) {
      return {
        ok: false, error: 'β output missing changes',
        cost_usd: envelope.total_cost_usd ?? 0, turns: envelope.num_turns ?? 0,
        session_id: envelope.session_id, envelope,
      };
    }
    return {
      ok: true,
      [outputKey]: parsed[outputKey],
        slice: parsed[outputKey],
        findings: parsed.findings,
        changes: parsed.changes || [],
        gaps: parsed.gaps,
        handoff_notes: parsed.handoff_notes || [],
        search_requests: parsed.search_requests || [],
        cost_usd: envelope.total_cost_usd ?? 0,
      turns: envelope.num_turns ?? 0,
      session_id: envelope.session_id ?? null,
      envelope,
    };
  }

  return {
    ok: true,
    slice: parsed,
    cost_usd: envelope.total_cost_usd ?? 0,
    turns: envelope.num_turns ?? 0,
    session_id: envelope.session_id ?? null,
    envelope,
  };
}
```

- [ ] **Step 3: Run, verify pass**

```bash
node tests/run.mjs framework/subtask-runner
```

Expected: 3 passed (2 α + 1 β).

- [ ] **Step 4: Commit**

```bash
git add framework/subtask-runner.mjs tests/framework/subtask-runner.test.mjs
git commit -m "feat(framework): subtask-runner now supports β union schema (slice + findings + gaps)"
```

---

### Task 5.3: Update prompts to request findings + gaps

**Files:**
- Modify: 4 subtask prompt templates

For each of the 4 prompt templates, replace the closing instruction:

```markdown
Output: a single JSON object matching the schema. No prose.
```

with:

````markdown
## Output format

Return a JSON object with four fields:

```
{
  "slice":    { ... <fields per the schema above> ... },
  "findings": [
    {
      "field":      "JSON path of a field, e.g. 'members[0].oneLiner'",
      "value":      <the value you put in slice at that path>,
      "source":     "primary URL where you verified it",
      "confidence": 0.0–1.0,
      "method":     "≤200 chars: how you verified, e.g. 'X bio + LinkedIn cross-check'",
      "supporting_sources": ["optional", "≤5 corroborating URLs"]
    }
    ],
    "gaps": [
      { "field": "JSON path", "reason": "≤500 chars why couldn't fill", "tried": ["≤10 method/source descriptions"] }
    ],
    "handoff_notes": [
      { "target": "metadata|team|funding|audits|reconcile", "note": "out-of-scope clue worth preserving", "source": "optional URL" }
    ]
  }
```

Rules for findings:
- One finding per non-trivial field you populated. Boilerplate fields (slug, displayName) don't need findings.
- `confidence < 0.7` indicates "I made my best guess but a follow-up agent should verify."
- Cite the URL you actually consulted, not a generic homepage.

Rules for gaps:
- Use when a required field is missing or you skipped it. Example: a member with `memberLink.linkedinLink: null` and you couldn't find one → gap with reason `"no public LinkedIn profile found"`, `tried: ["linkedin search", "X bio"]`.
- Empty array is fine if you filled everything confidently.

Rules for handoff notes:
- Use when you discover a useful clue outside your slice. Do not add out-of-scope
  fields to `slice`; preserve the clue here so R2 can synthesize across slices.
- Empty array is fine.

No prose. JSON only.
````

- [ ] **Step 1: Apply to `metadata.user.md.tmpl`**, `team.user.md.tmpl`, `funding.user.md.tmpl`, `audits.user.md.tmpl`. Each gets the same closing block (above), replacing whatever closing instruction was there.

- [ ] **Step 2: Commit**

```bash
git add consumers/protocol-info/prompts/{metadata,team,funding,audits}.user.md.tmpl
git commit -m "feat(consumer): subtask prompts request findings + gaps"
```

---

### Task 5.4: Merger accumulates findings + gaps

**Files:**
- Modify: `framework/merger.mjs`
- Modify: `tests/framework/merger.test.mjs`

- [ ] **Step 1: Add tests for β-shape**

Append to `tests/framework/merger.test.mjs`:
```js
tests.push({
  name: 'accumulates findings and gaps with stage + subtask tags',
  fn: async () => {
    const result = mergeSlices([
      { name: 'metadata', ok: true, slice: { slug: 's' },
        findings: [{ field: 'slug', value: 's', source: 'https://x', confidence: 1 }],
        gaps: [] },
      { name: 'team', ok: true, slice: { members: [] },
        findings: [],
        gaps: [{ field: 'members', reason: 'no team page found', tried: ['website'] }] },
    ], { stage: 'r1' });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].subtask, 'metadata');
    assert.equal(result.findings[0].stage, 'r1');
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].subtask, 'team');
    assert.equal(result.gaps[0].stage, 'r1');
  },
});
```

- [ ] **Step 2: Extend `mergeSlices`**

```js
export function mergeSlices(subtaskResults, opts = {}) {
  const stage = opts.stage || 'r1';
  const onCollision = opts.onCollision || ((field, by, prev) => {
    console.error(`[merger] collision on field "${field}": "${by}" overwrites "${prev}"`);
  });

  const record = {};
    const failed_subtasks = [];
    const findings = [];
    const gaps = [];
    const handoff_notes = [];
    const field_owner = {};

  for (const r of subtaskResults) {
    if (!r.ok) {
      failed_subtasks.push({ name: r.name, reason: r.error || 'unknown' });
      gaps.push({
        field: `<subtask:${r.name}>`,
        reason: `subtask_failed: ${r.error || 'unknown'}`,
        tried: [],
        stage, subtask: r.name,
      });
      continue;
    }
    if (r.slice && typeof r.slice === 'object') {
      for (const [k, v] of Object.entries(r.slice)) {
        if (k in record) onCollision(k, r.name, field_owner[k]);
        record[k] = v;
        field_owner[k] = r.name;
      }
    }
    if (Array.isArray(r.findings)) {
      for (const f of r.findings) findings.push({ ...f, stage, subtask: r.name });
    }
      if (Array.isArray(r.gaps)) {
        for (const g of r.gaps) gaps.push({ ...g, stage, subtask: r.name });
      }
      if (Array.isArray(r.handoff_notes)) {
        for (const h of r.handoff_notes) handoff_notes.push({ ...h, stage, subtask: r.name });
      }
    }

    return { record, findings, gaps, handoff_notes, failed_subtasks, field_owner };
  }
```

- [ ] **Step 3: Run tests**

```bash
node tests/run.mjs framework/merger
```

Expected: 4 passed (3 from before + 1 new).

- [ ] **Step 4: Commit**

```bash
git add framework/merger.mjs tests/framework/merger.test.mjs
git commit -m "feat(framework): merger accumulates findings/gaps/handoffs with stage+subtask tags"
```

---

### Task 5.5: Wire β output through r1.mjs + write findings/gaps/handoffs

**Files:**
- Modify: `framework/cli/r1.mjs`

- [ ] **Step 1: Update r1.mjs to load + pass findings/gaps schemas**

In `framework/cli/r1.mjs`, near the top after manifest load:

```js
import { dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK_DIR = pathDirname(fileURLToPath(import.meta.url)).replace(/\/cli$/, '');
const findingsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/findings.schema.json'), 'utf8'));
const gapsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/gaps.schema.json'), 'utf8'));
```

In the per-subtask task body, change the `runSubtask` call:

```js
const r = await runSubtask({
  claudeBin, subtask: st, systemPrompt, userPrompt, schemaSlice: slice,
  findingsSchema, gapsSchema,
});
```

After `mergeSlices`, write the new artifacts. Add new CLI args
`--findings-out`, `--gaps-out`, and `--handoff-out`:

```js
const findingsOut = arg('findings-out');
const gapsOut = arg('gaps-out');
const handoffOut = arg('handoff-out');

// ... after mergeSlices:
const merge = mergeSlices(results, { stage: 'r1' });

await writeFile(recordOut, JSON.stringify(merge.record, null, 2));
if (findingsOut) await writeFile(findingsOut, JSON.stringify(merge.findings, null, 2));
if (gapsOut) await writeFile(gapsOut, JSON.stringify(merge.gaps, null, 2));
if (handoffOut) await writeFile(handoffOut, JSON.stringify(merge.handoff_notes, null, 2));
```

- [ ] **Step 2: Update run.sh to pass new args**

```bash
node "$SCRIPT_DIR/framework/cli/r1.mjs" \
  --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
  --slug "$slug" \
  --provider "$provider" \
  --display-name "$display" \
  --type "$type" \
  --hints "$hints" \
  --evidence "$rootdata_pkt" \
  --record-out "$rec" \
    --findings-out "$slug_dir/findings.json" \
    --gaps-out "$slug_dir/gaps.json" \
    --handoff-out "$slug_dir/handoff_notes.json" \
  --debug-dir "$debug_dir/r1" \
  > /dev/null 2> "$r1_err" &
pid_claude=$!
```

- [ ] **Step 3: Smoke test**

```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle
OUT=$(ls -1t out | head -1)
jq 'length' out/$OUT/pendle/findings.json
jq '. | map({field, confidence, source}) | .[0:3]' out/$OUT/pendle/findings.json
jq '. | map({field, reason})' out/$OUT/pendle/gaps.json
jq '. | length' out/$OUT/pendle/handoff_notes.json
```

Expected: findings.json has plausible per-field entries; gaps.json lists genuinely-unfilled fields with reasons.

- [ ] **Step 4: Commit**

```bash
git add framework/cli/r1.mjs run.sh
git commit -m "feat: r1.mjs writes findings.json + gaps.json (β output)

- subtask-runner uses union schema (slice + findings + gaps)
- merger tags each finding/gap with stage='r1' + subtask name
- new artifacts: findings.json (per-field provenance), gaps.json (unfilled fields)
- record.json shape unchanged"
```

---

# Phase 6 — R2+ synthesis/deepening in Node + RootData search + audit-first guard

**Deliverable:** deterministic post-R1 evidence-diff prioritization,
RootData-backed structured search channel, `framework/cli/r2.mjs` + reconcile
prompt template; merger gains a `mergeR2(...)` function applying the audit-first
R2 guard. R2 synthesis runs by default; `max_research_rounds` and budget caps
bound any additional search/deepening rounds.

**Smoke test:** Even a clean R1 runs one synthesis pass; a slug whose R1 missed
RootData funding investors gets prioritized via `evidence_diff.funding.severity`;
a low-confidence field gets updated by R2; a high-confidence R1 field is
preserved unless R2 explains the change; a model-emitted RootData
`search_requests[]` entry appends `search_results[]` and drives one extra round.

---

### Task 6.0: Add post-R1 evidence-diff enrichment

**Files:**
- Create: `framework/evidence-diff.mjs`
- Create: `framework/cli/evidence-diff.mjs`
- Test: `tests/framework/evidence-diff.test.mjs`

- [ ] **Step 1: Add tests**

```js
import { strict as assert } from 'node:assert';
import { enrichEvidenceDiff } from '../../framework/evidence-diff.mjs';

export const tests = [
  {
    name: 'computes RootData funding discrepancy severity from R1 record',
    fn: async () => {
      const record = { fundingRounds: [{ investors: ['Paradigm'] }] };
      const evidence = {
        rootdata: {
          api_funding: {
            total_funding: '$10000000',
            investors_orgs_normalized: ['paradigm', 'dragonfly', 'variant'],
            investors_people: ['Alice'],
          },
        },
      };
      const out = enrichEvidenceDiff({ evidence, record });
      assert.equal(out.evidence_diff.funding.severity, 'medium');
      assert.deepEqual(out.evidence_diff.funding.missing_org_investors, ['dragonfly', 'variant']);
    },
  },
  {
    name: 'uses none when no comparable funding evidence exists',
    fn: async () => {
      const out = enrichEvidenceDiff({ evidence: {}, record: { fundingRounds: [] } });
      assert.equal(out.evidence_diff.funding.severity, 'none');
    },
  },
];
```

- [ ] **Step 2: Implement**

```js
function normInvestor(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+(capital|ventures|labs|fund|partners|investments|group|network)\s*$/i, '')
    .trim();
}

function severityForMissing(count) {
  if (count > 5) return 'high';
  if (count >= 2) return 'medium';
  if (count >= 1) return 'low';
  return 'none';
}

export function enrichEvidenceDiff({ evidence, record }) {
  const out = structuredClone(evidence || {});
  const r1Investors = new Set(
    (record?.fundingRounds || [])
      .flatMap(r => r.investors || [])
      .map(normInvestor)
      .filter(Boolean)
  );
  const api = out.rootdata?.api_funding || {};
  const apiOrgs = (api.investors_orgs_normalized || []).map(normInvestor).filter(Boolean);
  const missing = apiOrgs.filter(name => !r1Investors.has(name));

  out.evidence_diff = {
    ...(out.evidence_diff || {}),
    funding: {
      severity: apiOrgs.length ? severityForMissing(missing.length) : 'none',
      api_total_funding: api.total_funding || null,
      missing_org_investors: missing,
      api_angel_investors: api.investors_people || [],
    },
  };
  return out;
}
```

`framework/cli/evidence-diff.mjs` reads `--evidence-in`, `--record-in`, and
`--evidence-out`, calls `enrichEvidenceDiff`, and writes the enriched packet.
This preserves the bash-era investor discrepancy signal without asking fetchers
to classify data they cannot compare until R1 exists. The signal prioritizes R2
attention; it does not decide whether synthesis runs.

- [ ] **Step 3: Run**

```bash
node tests/run.mjs framework/evidence-diff
```

Expected: 2 passed.

---

### Task 6.0b: Add structured search-channel executor

**Files:**
- Create: `framework/search-channel.mjs`
- Test: `tests/framework/search-channel.test.mjs`

- [ ] **Step 1: Add tests**

```js
import { strict as assert } from 'node:assert';
import { runSearchRequests } from '../../framework/search-channel.mjs';

export const tests = [
  {
    name: 'runs approved search requests through fetcher search export',
    fn: async () => {
      const fetchers = [{
        name: 'rootdata',
        search: async ({ query, type }) => ({ channel: 'rootdata', query, type, ok: true, results: [{ id: 1 }] }),
      }];
      const out = await runSearchRequests({
        requests: [{ channel: 'rootdata', type: 'person', query: 'Pendle founder', reason: 'team verification' }],
        fetchers,
        maxQueries: 4,
        env: {},
        logger: console,
        round: 2,
      });
      assert.equal(out.length, 1);
      assert.equal(out[0].channel, 'rootdata');
      assert.deepEqual(out[0].results, [{ id: 1 }]);
    },
  },
  {
    name: 'drops unknown channels and caps query count',
    fn: async () => {
      const out = await runSearchRequests({
        requests: [
          { channel: 'unknown', type: 'project', query: 'x' },
          { channel: 'rootdata', type: 'project', query: 'y' },
        ],
        fetchers: [{ name: 'rootdata', search: async ({ query }) => ({ channel: 'rootdata', query, ok: true, results: [] }) }],
        maxQueries: 1,
        env: {},
        logger: console,
        round: 2,
      });
      assert.equal(out.length, 0);
    },
  },
];
```

- [ ] **Step 2: Implement**

```js
export async function runSearchRequests({ requests, fetchers, maxQueries, env, logger, round }) {
  const byName = new Map(fetchers.map(f => [f.name, f]));
  const out = [];
  for (const req of (requests || []).slice(0, maxQueries)) {
    const f = byName.get(req.channel);
    if (!f || typeof f.search !== 'function') {
      logger.warn?.(`[search] skipped unknown channel ${req.channel}`);
      continue;
    }
    const result = await f.search({ query: req.query, type: req.type, limit: req.limit || 5, env, logger });
    out.push({ round, reason: req.reason || '', ...result });
  }
  return out;
}
```

Search requests are model-authored but framework-approved: only manifest-enabled
channels run, query count is capped, and results are appended to evidence as
`search_results[]`.

- [ ] **Step 3: Run**

```bash
node tests/run.mjs framework/search-channel
```

Expected: 2 passed.

---

### Task 6.1: Author reconcile prompt template

**Files:**
- Modify: `consumers/protocol-info/prompts/reconcile.user.md.tmpl` (existing legacy file — rewrite for β shape)

- [ ] **Step 1: Replace its body with β-aware template**

```markdown
You are performing a Deep Search synthesis pass for an EarnProtocolInfo record.
Compare the full R1 record, all findings/gaps/handoff notes, structured evidence,
and your own fresh web research. Your job is not merely to repair failures; it
is to look for contradictions, missing depth, and stronger sources.

## Current record (what R1 produced)

```json
{{RECORD}}
```

## Findings from R1 (per-field provenance)

```json
{{FINDINGS}}
```

Pay special attention to entries with `confidence < 0.7` — those are flagged for verification.

## Gaps R1 couldn't fill

```json
{{GAPS}}
```

For each, decide whether new web-research can fill it.

## Cross-slice handoff notes

```json
{{HANDOFF_NOTES}}
```

These are useful clues discovered by focused R1 subtasks outside their own
slice. Use them as leads during synthesis.

## External evidence

```json
{{EVIDENCE}}
```

Compare against the record. Particular attention:

- **Funding rounds** — If `evidence_diff.funding.severity` is `medium` or `high`, investigate the listed `missing_org_investors`; the round history may be incomplete.
- **Establishment year** — If `rootdata.anchors.establishment.value` differs from `record.establishment`, treat RootData as strong evidence and resolve the conflict with fetched primary sources where possible.
- **Member candidates** — `rootdata.member_candidates` may include candidates with `bucket: 'likely_member'` not yet in `record.members`. Investigate before adding.
- **Validated overrides** — `rootdata.validated_overrides.providerWebsite` and `providerXLink` are strong evidence, not commands. Prefer the better-supported official source.
- **Search results** — `search_results[]` may contain RootData project/person search results from prior deepening rounds. Use them as leads, not ground truth.

## Output

Return a JSON object:

```
{
    "record":   { ... full revised record matching the schema below ... },
    "findings": [ ... per-field findings for any field you changed or re-verified ... ],
    "changes":  [ ... audited list of fields whose value differs from R1 ... ],
    "gaps":     [ ... gaps that remain unresolved after this round, with `tried` updated ... ],
    "search_requests": [
      { "channel": "rootdata", "type": "project|person", "query": "specific search query", "reason": "uncertainty this resolves" }
    ]
  }
```

Schema for `record`:

```json
{{SCHEMA}}
```

Rules:
- Return the WHOLE record (not just changes). Keep R1's values for fields you don't touch.
- For any field you change, emit a `changes[]` entry with `field`, `before`, `after`, `reason`, `source` when available, and `confidence`.
- For any changed field that represents a durable fact, also emit a finding with `confidence` reflecting your verification quality.
- For any R1 field with `confidence < 0.7` that you confirm without changing, emit a fresh finding with higher confidence.
- For gaps that remain, append `tried` entries describing what new attempts you made.
- RootData is a research channel, not an authority. Usually prefer RootData when it matches official/fetched evidence; if fetched web evidence contradicts RootData, keep the better-supported value and explain the conflict in `changes[]` or `gaps[]`.
- Emit `search_requests[]` only for targeted RootData project/person searches that would likely resolve a specific unresolved conflict. Empty array is fine.

No prose. JSON only.
```

- [ ] **Step 2: Commit**

```bash
git add consumers/protocol-info/prompts/reconcile.user.md.tmpl
git commit -m "feat(consumer): rewrite reconcile prompt for β output"
```

---

### Task 6.2: Audit-first guard in merger

**Files:**
- Modify: `framework/merger.mjs`
- Modify: `tests/framework/merger.test.mjs`

- [ ] **Step 1: Add tests for `mergeR2`**

Append:
```js
import { mergeR2 } from '../../framework/merger.mjs';

tests.push({
  name: 'mergeR2 accepts new R2 value when R1 had no finding for the field',
  fn: async () => {
    const r1 = {
      record: { description: 'old', tags: [] },
      findings: [{ field: 'description', value: 'old', source: 'https://x', confidence: 0.9 }],
      gaps: [],
    };
    const r2 = {
      record: { description: 'old', tags: ['yield'] },
      findings: [{ field: 'tags', value: ['yield'], source: 'https://y', confidence: 0.95 }],
      changes: [{ field: 'tags', before: [], after: ['yield'], reason: 'DeFiLlama category confirms yield', source: 'https://defillama.com', confidence: 0.95 }],
      gaps: [],
    };
    const m = mergeR2(r1, r2);
    assert.deepEqual(m.record.tags, ['yield']);
  },
});

tests.push({
  name: 'mergeR2 rejects uncited R2 change to a high-confidence R1 field',
  fn: async () => {
    const r1 = {
      record: { description: 'GOOD' },
      findings: [{ field: 'description', value: 'GOOD', source: 'https://x', confidence: 0.92 }],
      gaps: [],
    };
    const r2 = {
      record: { description: 'WEAKER' },
      findings: [],
      changes: [],
      gaps: [],
    };
    const m = mergeR2(r1, r2);
    assert.equal(m.record.description, 'GOOD');
    assert.ok(m.gaps.some(g => g.reason && g.reason.includes('r2_uncited_high_conf_change_suppressed')));
  },
});

tests.push({
  name: 'mergeR2 accepts R2 when R2 has higher confidence than R1',
  fn: async () => {
    const r1 = {
      record: { description: 'guess' },
      findings: [{ field: 'description', value: 'guess', source: 'https://x', confidence: 0.5 }],
      gaps: [],
    };
    const r2 = {
      record: { description: 'verified' },
      findings: [{ field: 'description', value: 'verified', source: 'https://y', confidence: 0.95 }],
      changes: [{ field: 'description', before: 'guess', after: 'verified', reason: 'official docs wording', source: 'https://y', confidence: 0.95 }],
      gaps: [],
    };
    const m = mergeR2(r1, r2);
    assert.equal(m.record.description, 'verified');
  },
});

tests.push({
  name: 'mergeR2 treats array descendant/entity_key evidence as explanation',
  fn: async () => {
    const r1 = {
      record: { members: [{ memberName: 'A', oneLiner: 'old', memberLink: { xLink: 'https://x.com/a' } }] },
      findings: [{ field: 'members', value: [], source: 'https://x', confidence: 0.92 }],
      gaps: [],
    };
    const r2 = {
      record: { members: [{ memberName: 'A', oneLiner: 'new', memberLink: { xLink: 'https://x.com/a' } }] },
      findings: [{ field: 'members[0].oneLiner', entity_key: 'member:x:https://x.com/a', value: 'new', source: 'https://y', confidence: 0.95 }],
      changes: [{ field: 'members[0].oneLiner', entity_key: 'member:x:https://x.com/a', before: 'old', after: 'new', reason: 'profile updated', source: 'https://y', confidence: 0.95 }],
      gaps: [],
    };
    const m = mergeR2(r1, r2);
    assert.equal(m.record.members[0].oneLiner, 'new');
    assert.equal(m.gaps.some(g => g.reason === 'uncited_r2_change'), false);
  },
});
```

- [ ] **Step 2: Implement `mergeR2`**

Append to `framework/merger.mjs`:
```js
// Merges R2 output back into R1 with the audit-first guard.
// Audit-first rule:
//   - R2 may change fields freely when it emits a matching changes[] or finding.
//   - If R2 changes a high-confidence R1 field without any matching change/finding,
//     keep R1 and add a suppression gap.
//   - If R2 changes a lower-confidence/unfound field without provenance, accept it
//     but add an uncited_r2_change gap for review.
//
// Field-level granularity: walks both records' top-level keys, then recurses
// into objects. Arrays are replaced wholesale, but item-level descendant paths
// or shared entity_key values count as explanations for the array change.

const HIGH_CONF = 0.85;

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pathMatches(entryPath, changedPath) {
  if (!entryPath) return false;
  return entryPath === changedPath ||
    entryPath.startsWith(`${changedPath}.`) ||
    entryPath.startsWith(`${changedPath}[`);
}

function entityKeysFor(value) {
  const keys = new Set();
  const add = v => { if (v) keys.add(v); };
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    add(item.entity_key);
    if (item.memberLink?.xLink) add(`member:x:${item.memberLink.xLink}`);
    if (item.memberLink?.linkedinLink) add(`member:linkedin:${item.memberLink.linkedinLink}`);
    if (item.memberName) add(`member:name:${String(item.memberName).toLowerCase()}`);
    if (item.round && item.date) add(`funding:${item.round}:${item.date}`);
    if (item.auditor && item.reportUrl) add(`audit:${item.auditor}:${item.reportUrl}`);
  };
  if (Array.isArray(value)) value.forEach(visit);
  else visit(value);
  return keys;
}

function evidenceFor(entries, fieldPath, entityKeys = new Set()) {
  if (!Array.isArray(entries)) return null;
  return entries.find(e =>
    pathMatches(e.field, fieldPath) ||
    (e.entity_key && entityKeys.has(e.entity_key))
  ) || null;
}

function mergeRecursive(r1Val, r2Val, path, r1Findings, r2Findings, r2Changes, gaps) {
  if (r2Val === undefined) return r1Val;
  if (r1Val === undefined) return r2Val;

  // Object-typed values: recurse on keys.
  if (r1Val && r2Val && typeof r1Val === 'object' && typeof r2Val === 'object'
      && !Array.isArray(r1Val) && !Array.isArray(r2Val)) {
    const out = { ...r1Val };
    for (const k of new Set([...Object.keys(r1Val), ...Object.keys(r2Val)])) {
      out[k] = mergeRecursive(r1Val[k], r2Val[k], path ? `${path}.${k}` : k, r1Findings, r2Findings, r2Changes, gaps);
    }
    return out;
  }

  // Leaf or array: apply audit-first guard.
  if (sameJson(r1Val, r2Val)) return r2Val;
  const entityKeys = new Set([...entityKeysFor(r1Val), ...entityKeysFor(r2Val)]);
  const r1f = evidenceFor(r1Findings, path, entityKeys);
  const r2f = evidenceFor(r2Findings, path, entityKeys);
  const r2c = evidenceFor(r2Changes, path, entityKeys);
  const explained = !!(r2f || r2c);
  if (!explained && r1f && r1f.confidence > HIGH_CONF) {
    gaps.push({
      field: path,
      reason: `r2_uncited_high_conf_change_suppressed: r1.confidence=${r1f.confidence}`,
      tried: [],
      stage: 'r2',
      subtask: 'reconcile',
    });
    return r1Val;
  }
  if (!explained) {
    gaps.push({
      field: path,
      reason: 'uncited_r2_change',
      tried: [],
      stage: 'r2',
      subtask: 'reconcile',
    });
  }
  return r2Val;
}

export function mergeR2(r1, r2) {
  const auditGaps = [];
  const merged_record = mergeRecursive(
    r1.record, r2.record, '',
    r1.findings, r2.findings, r2.changes || [],
    auditGaps
  );

  // findings: keep R1's, then overlay R2's (R2 newer = wins on dup field path)
  const findings = [
    ...(r1.findings || []).filter(f => !(r2.findings || []).some(rf => rf.field === f.field)),
    ...((r2.findings || []).map(f => ({ ...f, stage: 'r2', subtask: 'reconcile' }))),
  ];

  // gaps: keep R1's gaps that R2 didn't address; add R2's; add suppression entries
  const r2GapFields = new Set((r2.gaps || []).map(g => g.field));
  const r2FindingFields = new Set((r2.findings || []).map(f => f.field));
  const gaps = [
    ...(r1.gaps || []).filter(g => !r2GapFields.has(g.field) && !r2FindingFields.has(g.field)),
    ...((r2.gaps || []).map(g => ({ ...g, stage: 'r2', subtask: 'reconcile' }))),
    ...auditGaps,
  ];

  const changes = [
    ...((r1.changes || []).map(c => c)),
    ...((r2.changes || []).map(c => ({ ...c, stage: 'r2', subtask: 'reconcile' }))),
  ];

  return { record: merged_record, findings, changes, gaps };
}
```

- [ ] **Step 3: Run tests**

```bash
node tests/run.mjs framework/merger
```

Expected: 7 passed.

- [ ] **Step 4: Commit**

```bash
git add framework/merger.mjs tests/framework/merger.test.mjs
git commit -m "feat(framework): mergeR2 with audit-first change guard

- R2 changes are accepted when explained by changes[] or findings[]
- threshold: HIGH_CONF=0.85 — uncited changes to these fields are protected
- suppressed regressions emit gap entries with reason 'r2_uncited_high_conf_change_suppressed'
- recurse into objects; arrays replaced wholesale (subject to same guard)"
```

---

### Task 6.3: Implement framework/cli/r2.mjs

**Files:**
- Create: `framework/cli/r2.mjs`

- [ ] **Step 1: Implement**

```js
// framework/cli/r2.mjs — R2 reconcile executor.
// Reads R1 record + findings + gaps + evidence, runs reconcile prompt,
// applies audit-first guard via merger.mergeR2, writes outputs.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';
import { runSubtask } from '../subtask-runner.mjs';
import { mergeR2 } from '../merger.mjs';
import { runSearchRequests } from '../search-channel.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/cli$/, '');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const recordIn = arg('record-in');
const findingsIn = arg('findings-in');
const gapsIn = arg('gaps-in');
const handoffIn = arg('handoff-in', null);
const evidencePath = arg('evidence');
const recordOut = arg('record-out');
const findingsOut = arg('findings-out');
const changesOut = arg('changes-out');
const gapsOut = arg('gaps-out');
const debugDir = arg('debug-dir');
const sessionId = arg('session', null);   // resume R1's session if available
const claudeBin = process.env.CLAUDE_BIN || 'claude';

if (!manifestPath || !recordIn || !findingsIn || !gapsIn || !evidencePath || !recordOut || !debugDir) {
  console.error('usage: r2.mjs --manifest M --record-in R --findings-in F --gaps-in G [--handoff-in H] --evidence E --record-out R2 [--findings-out F2] [--gaps-out G2] --debug-dir D [--session S]');
  process.exit(2);
}

await mkdir(debugDir, { recursive: true });

const manifest = await loadManifest(manifestPath);
if (!manifest.reconcile?.enabled) {
  console.error('[r2] manifest.reconcile.enabled is false; copying R1 outputs unchanged');
  const r1Record = JSON.parse(await readFile(recordIn, 'utf8'));
  const r1Findings = JSON.parse(await readFile(findingsIn, 'utf8'));
  const r1Gaps = JSON.parse(await readFile(gapsIn, 'utf8'));
  await writeFile(recordOut, JSON.stringify(r1Record, null, 2));
  if (findingsOut) await writeFile(findingsOut, JSON.stringify(r1Findings, null, 2));
  if (changesOut) await writeFile(changesOut, JSON.stringify([], null, 2));
  if (gapsOut) await writeFile(gapsOut, JSON.stringify(r1Gaps, null, 2));
  process.exit(0);
}

const r1Record = JSON.parse(await readFile(recordIn, 'utf8'));
const r1Findings = JSON.parse(await readFile(findingsIn, 'utf8'));
const r1Gaps = JSON.parse(await readFile(gapsIn, 'utf8'));
const handoffNotes = handoffIn ? JSON.parse(await readFile(handoffIn, 'utf8')) : [];
let evidence = JSON.parse(await readFile(evidencePath, 'utf8'));

const fullSchema = JSON.parse(await readFile(manifest._abs.full_schema, 'utf8'));
const findingsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/findings.schema.json'), 'utf8'));
const changesSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/changes.schema.json'), 'utf8'));
const gapsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/gaps.schema.json'), 'utf8'));
const reconcileTmpl = await readFile(manifest._abs.reconcile_prompt, 'utf8');

function render(t, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), t);
}

const r2Subtask = {
  name: 'reconcile',
  max_turns: manifest.reconcile.max_turns ?? 10,
  max_budget_usd: manifest.reconcile.max_budget_usd ?? 0.50,
};

const searchFetchers = [];
for (const f of manifest._abs.fetchers || []) {
  if (!f.search?.enabled) continue;
  const mod = await import(pathToFileURL(f.module_abs).href);
  if (typeof mod.search === 'function') searchFetchers.push({ name: f.name, search: mod.search });
}

let state = { record: r1Record, findings: r1Findings, changes: [], gaps: r1Gaps };
const maxRounds = manifest.reconcile.max_research_rounds ?? 3;
for (let round = 1; round <= maxRounds; round++) {
  const userPrompt = render(reconcileTmpl, {
    RECORD: JSON.stringify(state.record, null, 2),
    FINDINGS: JSON.stringify(state.findings, null, 2),
    GAPS: JSON.stringify(state.gaps, null, 2),
    HANDOFF_NOTES: JSON.stringify(handoffNotes, null, 2),
    EVIDENCE: JSON.stringify(evidence, null, 2),
    SCHEMA: JSON.stringify(fullSchema, null, 2),
  });

  const result = await runSubtask({
    claudeBin,
    subtask: r2Subtask,
    systemPrompt: '',
    userPrompt,
    schemaSlice: fullSchema,
    findingsSchema,
    changesSchema,
    gapsSchema,
    outputKey: 'record',
    resumeSession: round === 1 ? sessionId : null,
  });

  if (result.envelope) {
    await writeFile(join(debugDir, `reconcile.round${round}.envelope.json`), JSON.stringify(result.envelope, null, 2));
  }
  if (!result.ok) {
    console.error(`[r2] round ${round} failed: ${result.error}; keeping previous state`);
    break;
  }

  state = mergeR2(state, {
    record: result.record,
    findings: result.findings,
    changes: result.changes,
    gaps: result.gaps,
  });

  const requests = result.search_requests || [];
  if (requests.length === 0 || round === maxRounds) break;
  const searchResults = await runSearchRequests({
    requests,
    fetchers: searchFetchers,
    maxQueries: manifest.reconcile.max_search_queries_per_round ?? 4,
    env: process.env,
    logger: console,
    round: round + 1,
  });
  if (searchResults.length === 0) break;
  evidence = {
    ...evidence,
    search_results: [...(evidence.search_results || []), ...searchResults],
  };
}

await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
await writeFile(recordOut, JSON.stringify(state.record, null, 2));
if (findingsOut) await writeFile(findingsOut, JSON.stringify(state.findings, null, 2));
if (changesOut) await writeFile(changesOut, JSON.stringify(state.changes, null, 2));
if (gapsOut) await writeFile(gapsOut, JSON.stringify(state.gaps, null, 2));

console.error(`[r2] done — synthesis/deepening complete`);
process.exit(0);
```

- [ ] **Step 2: Update manifest**

Add `reconcile` block to `consumers/protocol-info/manifest.json`:
```json
"reconcile": {
  "enabled": true,
  "prompt": "./prompts/reconcile.user.md.tmpl",
  "max_turns": 10,
  "max_budget_usd": 0.50,
  "mode": "deep",
  "max_research_rounds": 3,
  "max_search_queries_per_round": 4,
  "fast_skip_allowed": false
}
```

- [ ] **Step 3: Wire R2 into run.sh**

Replace the existing R2 block in `run.sh` (the one with `claude -p - --resume "$SESSION_ID"`) with:

```bash
# Read R1 metadata subtask's session id for R2 resume
SESSION_ID=$(jq -r '.session_id // empty' "$debug_dir/r1/metadata.envelope.json" 2>/dev/null || echo "")

node "$SCRIPT_DIR/framework/cli/r2.mjs" \
  --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
  --record-in "$rec" \
    --findings-in "$slug_dir/findings.json" \
    --gaps-in "$slug_dir/gaps.json" \
    --handoff-in "$slug_dir/handoff_notes.json" \
    --evidence "$rootdata_pkt" \
  --record-out "$rec.r2" \
  --findings-out "$slug_dir/findings.json.r2" \
  --changes-out "$slug_dir/changes.json.r2" \
  --gaps-out "$slug_dir/gaps.json.r2" \
  --debug-dir "$debug_dir" \
  ${SESSION_ID:+--session "$SESSION_ID"} \
  2> "$r2_err"

# Adopt R2 outputs as canonical (R1 fallback was already written by R2 on failure)
mv "$rec.r2" "$rec"
mv "$slug_dir/findings.json.r2" "$slug_dir/findings.json"
mv "$slug_dir/changes.json.r2" "$slug_dir/changes.json"
mv "$slug_dir/gaps.json.r2" "$slug_dir/gaps.json"
```

Remove the legacy R2 bash block (the big section under `if [[ -z "$SESSION_ID" ]]; then ... else ... fi`) — it's now subsumed by `r2.mjs`.

- [ ] **Step 4: Smoke test**

```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle 2>&1 | tail -25
OUT=$(ls -1t out | head -1)
ls out/$OUT/pendle/_debug/
jq '. | map({field, confidence, stage, subtask})' out/$OUT/pendle/findings.json
```

Expected: `_debug/` contains `reconcile.round1.envelope.json`; findings includes some entries with `stage: "r2"` and `changes.json` exists.

- [ ] **Step 5: Run check-all**

```bash
node scripts/check-all.mjs
```

- [ ] **Step 6: Commit**

```bash
git add framework/evidence-diff.mjs framework/cli/evidence-diff.mjs framework/cli/r2.mjs consumers/protocol-info/manifest.json run.sh
git commit -m "feat: R2 reconcile in Node + evidence-diff + audit-first guard

- r2.mjs reads R1 outputs + evidence, runs reconcile prompt
- evidence-diff preserves bash-era RootData funding discrepancy severity
- default-on synthesis pass; evidence_diff prioritizes conflicts instead of gating
- supports RootData search_requests for bounded extra deepening rounds
- mergeR2 applies audit-first guard (uncited high-conf changes protected)
- removes legacy bash R2 block; pipeline cleanup deferred to phase 9"
```

---

### Task 6.4: Add deterministic final normalizer before validation

**Files:**
- Create: `framework/normalizer-stage.mjs`
- Create: `framework/cli/normalize.mjs`
- Create: `consumers/protocol-info/normalizers/final.mjs`
- Modify: `consumers/protocol-info/manifest.json`
- Modify: `run.sh`

This stage is deliberately narrow. It may set crawler metadata and perform
schema-shape repairs that are not research claims. It must not mechanically
override factual fields like `providerWebsite` or `providerXLink`; those remain
Deep Search evidence handled by R2.

- [ ] **Step 1: Add manifest normalizers block**

```json
"normalizers": [
  { "name": "protocol-info-final", "module": "./normalizers/final.mjs" }
]
```

- [ ] **Step 2: Implement consumer normalizer**

```js
// consumers/protocol-info/normalizers/final.mjs
// Deterministic metadata only. No factual web-claim overrides.

export default function normalize({ record, now = new Date() }) {
  const out = JSON.parse(JSON.stringify(record));
  const changes = [];
  const today = now.toISOString().slice(0, 10);

  if (out.audits && Array.isArray(out.audits.items)) {
    const before = out.audits.lastScannedAt;
    if (before !== today) {
      out.audits.lastScannedAt = today;
      changes.push({
        field: 'audits.lastScannedAt',
        before,
        after: today,
        reason: 'crawler scan date',
        source: 'framework:normalizer',
        confidence: 1,
      });
    }
  }

  return { record: out, changes, gaps: [] };
}
```

- [ ] **Step 3: Implement framework normalizer stage + CLI**

`framework/normalizer-stage.mjs` loads each `manifest._abs.normalizers[]`,
passes `{record, evidence, manifest}`, and returns `{record, changes, gaps}`.
`framework/cli/normalize.mjs` reads `--record-in`, `--evidence`,
`--changes-in`, `--gaps-in`, writes `--record-out`, `--changes-out`,
`--gaps-out`.

Important: append normalizer changes to `changes.json`; do not overwrite R2
changes.

- [ ] **Step 4: Wire into run.sh**

After adopting R2 outputs and before schema validation:

```bash
node "$SCRIPT_DIR/framework/cli/normalize.mjs" \
  --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
  --record-in "$rec" \
  --evidence "$rootdata_pkt" \
  --changes-in "$slug_dir/changes.json" \
  --gaps-in "$slug_dir/gaps.json" \
  --record-out "$rec.normalized" \
  --changes-out "$slug_dir/changes.json.normalized" \
  --gaps-out "$slug_dir/gaps.json.normalized" \
  2> "$debug_dir/normalize.stderr.log"

mv "$rec.normalized" "$rec"
mv "$slug_dir/changes.json.normalized" "$slug_dir/changes.json"
mv "$slug_dir/gaps.json.normalized" "$slug_dir/gaps.json"
```

- [ ] **Step 5: Smoke test**

```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle
OUT=$(ls -1t out | head -1)
jq '.audits.lastScannedAt' out/$OUT/pendle/record.json
jq '.[] | select(.field=="audits.lastScannedAt")' out/$OUT/pendle/changes.json
```

Expected: `audits.lastScannedAt` equals today's UTC date and the normalizer
change is present when the field changed.

- [ ] **Step 6: Commit**

```bash
git add framework/normalizer-stage.mjs framework/cli/normalize.mjs consumers/protocol-info/normalizers/final.mjs consumers/protocol-info/manifest.json run.sh
git commit -m "feat: add deterministic final normalizer before validation"
```

---

# Phase 7 — i18n in Node

**Deliverable:** `framework/i18n-stage.mjs` replaces bash `i18n_dispatch`. Manifest's `i18n.translatable_fields` drives field selection. Per-locale Haiku calls remain functionally identical.

**Smoke test:** `--i18n zh_CN,ja_JP` produces same per-locale sidecars as v0.4.0 (modulo translation variance).

---

### Task 7.1: Implement framework/i18n-stage.mjs

**Files:**
- Create: `framework/i18n-stage.mjs`
- Test: `tests/framework/i18n-stage.test.mjs`

- [ ] **Step 1: Write tests for path extraction (no Claude needed)**

Create `tests/framework/i18n-stage.test.mjs`:
```js
import { strict as assert } from 'node:assert';
import { extractTranslatable, mergeTranslated } from '../../framework/i18n-stage.mjs';

export const tests = [
  {
    name: 'extractTranslatable picks scalar field',
    fn: async () => {
      const out = extractTranslatable({ description: 'hello', x: 1 }, ['description']);
      assert.deepEqual(out, { description: 'hello' });
    },
  },
  {
    name: 'extractTranslatable picks fields under array index wildcard',
    fn: async () => {
      const out = extractTranslatable(
        { members: [{ memberPosition: 'CEO', oneLiner: 'a', skip: 'x' }, { memberPosition: 'CTO', oneLiner: 'b', skip: 'y' }] },
        ['members[].memberPosition', 'members[].oneLiner']
      );
      assert.deepEqual(out, {
        members: [
          { memberPosition: 'CEO', oneLiner: 'a' },
          { memberPosition: 'CTO', oneLiner: 'b' },
        ],
      });
    },
  },
  {
    name: 'mergeTranslated merges back into a base record',
    fn: async () => {
      const base = { slug: 's', description: 'EN', members: [{ memberName: 'A', memberPosition: 'EN_POS', oneLiner: 'EN_OL' }] };
      const tr = { description: 'ZH', members: [{ memberPosition: 'ZH_POS', oneLiner: 'ZH_OL' }] };
      const out = mergeTranslated(base, tr);
      assert.equal(out.description, 'ZH');
      assert.equal(out.members[0].memberName, 'A');
      assert.equal(out.members[0].memberPosition, 'ZH_POS');
      assert.equal(out.members[0].oneLiner, 'ZH_OL');
    },
  },
];
```

- [ ] **Step 2: Run, verify fail (LOAD FAIL)**

```bash
node tests/run.mjs framework/i18n-stage
```

- [ ] **Step 3: Implement**

```js
// Generic i18n stage. Consumer's manifest.i18n.translatable_fields drives
// which subset of the record gets translated. Per-locale Haiku call writes
// out a sidecar JSON of just the translated subset.
//
// Path syntax in translatable_fields:
//   - "description"               → top-level field
//   - "members[].memberPosition"  → field under each array element

import { runClaude } from './claude-wrapper.mjs';
import { runWithLimit } from './parallel-runner.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function extractTranslatable(record, paths) {
  const out = {};
  for (const path of paths) {
    if (path.includes('[]')) {
      const [arrayKey, ...rest] = path.split('[].');
      const subPath = rest.join('[].');
      const arr = record[arrayKey];
      if (!Array.isArray(arr)) continue;
      if (!Array.isArray(out[arrayKey])) out[arrayKey] = arr.map(() => ({}));
      arr.forEach((item, i) => {
        const v = item?.[subPath];
        if (v !== undefined) out[arrayKey][i][subPath] = v;
      });
    } else {
      if (record[path] !== undefined) out[path] = record[path];
    }
  }
  return out;
}

export function mergeTranslated(base, translated) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(translated)) {
    if (Array.isArray(v) && Array.isArray(out[k])) {
      v.forEach((tItem, i) => {
        if (out[k][i] && tItem && typeof tItem === 'object') {
          out[k][i] = { ...out[k][i], ...tItem };
        }
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function runI18nStage({
  manifest,           // loaded manifest with _abs
  record,             // source-language record.json content
  selectedLocales,    // array of locale codes from --i18n
  outputDir,          // _debug/i18n/ for sidecars + envelopes + failures.log
  parallelism = 8,
  claudeBin = 'claude',
  modelOverride = null,
  budgetLedger = null,
  logger = console,
}) {
  if (!manifest.i18n?.enabled) return { ok: 0, failed: [], translations: {} };
  if (selectedLocales.length === 0) return { ok: 0, failed: [], translations: {} };

  await mkdir(outputDir, { recursive: true });

  const i18nCfg = manifest._abs.i18n;
  const sysPrompt = await readFile(i18nCfg.system_prompt_abs, 'utf8');
  const userTmpl = await readFile(i18nCfg.user_prompt_abs, 'utf8');
  const i18nSchema = JSON.parse(await readFile(i18nCfg.schema_abs, 'utf8'));
  const sourceJson = extractTranslatable(record, manifest.i18n.translatable_fields);

  const localeNameByCode = Object.fromEntries(
    (manifest.i18n.locale_catalog || []).map(e => [e.code, e.name_en])
  );

  const tasks = selectedLocales.map(code => async () => {
    const localeName = localeNameByCode[code] || code;
    const userPrompt = userTmpl
      .replaceAll('{{LOCALE_CODE}}', code)
      .replaceAll('{{LOCALE_NAME}}', localeName)
      .replaceAll('{{SOURCE_JSON}}', JSON.stringify(sourceJson, null, 2));

    try {
      const env = await runClaude({
        claudeBin,
        systemPrompt: sysPrompt,
        userPrompt,
        schemaJson: i18nSchema,
        maxTurns: 3,
        maxBudgetUsd: manifest.i18n.max_budget_usd_per_call ?? 0.10,
        model: modelOverride || manifest.i18n.model_default,
        budgetLedger,
      });
      const out = env.structured_output && typeof env.structured_output === 'object'
        ? env.structured_output
        : (typeof env.structured_output === 'string' ? JSON.parse(env.structured_output) : null);
      if (!out) throw new Error('no structured_output');
      await writeFile(join(outputDir, `${code}.json`), JSON.stringify(out, null, 2));
      await writeFile(join(outputDir, `${code}.envelope.json`), JSON.stringify(env, null, 2));
      return { code, ok: true, translation: out, cost_usd: env.total_cost_usd ?? 0 };
    } catch (err) {
      const fl = join(outputDir, 'failures.log');
      await writeFile(fl, `${code}\t${err.message}\n`, { flag: 'a' });
      logger.warn?.(`[i18n:${code}] ${err.message}`);
      return { code, ok: false, error: err.message };
    }
  });

  const results = await runWithLimit(parallelism, tasks);
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).map(r => r.code);
  const translations = Object.fromEntries(
    results.filter(r => r.ok).map(r => [r.code, r.translation])
  );
  return { ok, failed, translations };
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
node tests/run.mjs framework/i18n-stage
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add framework/i18n-stage.mjs tests/framework/i18n-stage.test.mjs
git commit -m "feat(framework): i18n-stage with translatable_fields path extractor"
```

---

### Task 7.2: Wire i18n-stage into the pipeline + remove bash i18n_dispatch

**Files:**
- Create: `framework/cli/i18n.mjs`
- Modify: `consumers/protocol-info/manifest.json` (add full i18n config)
- Modify: `run.sh` (remove bash i18n_dispatch + functions, replace with cli/i18n.mjs invocation)

- [ ] **Step 1: Add full i18n config to manifest**

```json
"i18n": {
  "enabled": true,
  "model_default": "claude-haiku-4-5-20251001",
  "max_budget_usd_per_call": 0.10,
  "system_prompt": "./prompts/i18n.system.md",
  "user_prompt": "./prompts/i18n.user.md.tmpl",
  "schema": "./schemas/i18n.json",
  "translatable_fields": ["description", "members[].memberPosition", "members[].oneLiner"],
  "locale_catalog": [
    { "code": "bn", "name_zh": "孟加拉语", "name_en": "Bengali" },
    { "code": "de", "name_zh": "德语", "name_en": "German" },
    { "code": "en_US", "name_zh": "英语(美国)", "name_en": "English (US)" },
    { "code": "es", "name_zh": "西班牙语", "name_en": "Spanish" },
    { "code": "fr_FR", "name_zh": "法语", "name_en": "French" },
    { "code": "hi_IN", "name_zh": "印地语", "name_en": "Hindi" },
    { "code": "id", "name_zh": "印尼语", "name_en": "Indonesian" },
    { "code": "it_IT", "name_zh": "意大利语", "name_en": "Italian" },
    { "code": "ja_JP", "name_zh": "日语", "name_en": "Japanese" },
    { "code": "ko_KR", "name_zh": "韩语", "name_en": "Korean" },
    { "code": "pt", "name_zh": "葡萄牙语", "name_en": "Portuguese" },
    { "code": "pt_BR", "name_zh": "葡萄牙语(巴西)", "name_en": "Portuguese (Brazil)" },
    { "code": "ru", "name_zh": "俄语", "name_en": "Russian" },
    { "code": "th_TH", "name_zh": "泰语", "name_en": "Thai" },
    { "code": "uk_UA", "name_zh": "乌克兰语", "name_en": "Ukrainian" },
    { "code": "vi", "name_zh": "越南语", "name_en": "Vietnamese" },
    { "code": "zh_CN", "name_zh": "简体中文", "name_en": "Simplified Chinese" },
    { "code": "zh_HK", "name_zh": "繁体中文(香港)", "name_en": "Traditional Chinese (Hong Kong)" },
    { "code": "zh_TW", "name_zh": "繁体中文(台湾)", "name_en": "Traditional Chinese (Taiwan)" }
  ]
}
```

- [ ] **Step 2: Implement framework/cli/i18n.mjs**

```js
// framework/cli/i18n.mjs — bash-callable i18n stage.
// Usage:
//   node framework/cli/i18n.mjs --manifest M --record R --locales LIST --output-dir D [--parallel N] [--model M]

import { readFile } from 'node:fs/promises';
import { loadManifest } from '../manifest-loader.mjs';
import { runI18nStage } from '../i18n-stage.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const recordPath = arg('record');
const localesArg = arg('locales', '');
const outputDir = arg('output-dir');
const parallelism = parseInt(arg('parallel', '8'), 10);
const modelOverride = arg('model', null);

if (!manifestPath || !recordPath || !outputDir) {
  console.error('usage: i18n.mjs --manifest M --record R --locales <comma-list> --output-dir D');
  process.exit(2);
}

const manifest = await loadManifest(manifestPath);
const record = JSON.parse(await readFile(recordPath, 'utf8'));
const selectedLocales = localesArg.split(',').map(s => s.trim()).filter(Boolean);

const result = await runI18nStage({
  manifest, record, selectedLocales, outputDir, parallelism, modelOverride,
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  logger: { info: m => console.error(`[i18n] ${m}`), warn: m => console.error(`[i18n:warn] ${m}`) },
});

console.error(`[i18n] ${result.ok}/${selectedLocales.length} ok; failed: ${result.failed.join(',') || 'none'}`);
process.exit(0);
```

- [ ] **Step 3: Replace bash i18n_dispatch in run.sh**

Find and remove all of these from `run.sh`:
- `i18n_pick_interactive()` function
- `i18n_resolve_selection()` function
- `i18n_translate_one()` function
- `i18n_dispatch()` function
- `dashboard_locale_for()` function (moves to consumer post in phase 8 — keep for now? actually we still need it for export. Leave until phase 8.)
- `locale_name_for()` function (moves to manifest catalog access — same: leave for export.)
- The `if [[ ${#OK_SLUGS[@]} -gt 0 && ${#I18N_SELECTED[@]} -gt 0 ]]; then i18n_dispatch ...` block

Replace with new logic that:
1. Resolves I18N_ARG → comma-list of locale codes (keep the existing CLI parsing in bash; it's terse)
2. Calls cli/i18n.mjs once per OK slug

```bash
# After main loop, after OK_SLUGS collected:

# Resolve --i18n flag
case "$I18N_ARG" in
  none|"") I18N_LOCALES_LIST="" ;;
  all)
    I18N_LOCALES_LIST=$(jq -r '.i18n.locale_catalog[].code' "$SCRIPT_DIR/consumers/protocol-info/manifest.json" | tr '\n' ',' | sed 's/,$//')
    ;;
  *) I18N_LOCALES_LIST="$I18N_ARG" ;;
esac

if [[ -n "$I18N_LOCALES_LIST" && "$DRY_RUN" -ne 1 && ${#OK_SLUGS[@]} -gt 0 ]]; then
  echo ""
  echo "=== i18n translation (Haiku) ==="
  for _slug in "${OK_SLUGS[@]}"; do
    echo "[$_slug] translating to: $I18N_LOCALES_LIST"
    node "$SCRIPT_DIR/framework/cli/i18n.mjs" \
      --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
      --record "$OUT_DIR/$_slug/record.json" \
      --locales "$I18N_LOCALES_LIST" \
      --output-dir "$OUT_DIR/$_slug/_debug/i18n" \
      --parallel "$I18N_PARALLEL" \
      ${I18N_MODEL:+--model "$I18N_MODEL"} \
      || true
  done
  unset _slug
fi
```

- [ ] **Step 4: Smoke test**

```bash
./run.sh --i18n zh_CN,ja_JP --display-name "Pendle" --type fixed_rate --slug pendle 2>&1 | tail -15
OUT=$(ls -1t out | head -1)
ls out/$OUT/pendle/_debug/i18n/
```

Expected: `zh_CN.json`, `zh_CN.envelope.json`, `ja_JP.json`, `ja_JP.envelope.json` present.

- [ ] **Step 5: Commit**

```bash
git add framework/cli/i18n.mjs consumers/protocol-info/manifest.json run.sh
git commit -m "feat: i18n stage routed through framework/cli/i18n.mjs

- removes ~250 lines of bash i18n_dispatch / i18n_translate_one / etc.
- manifest.i18n.locale_catalog is now the single source of truth for locales
- per-locale Haiku call sequence + outputs unchanged for backward compat
- --i18n all reads catalog from manifest (was hardcoded in bash)"
```

---

# Phase 8 — Export in Node (locale-map + dashboard-export)

**Deliverable:** `consumers/protocol-info/post/locale-map.mjs` and `consumers/protocol-info/post/dashboard-export.mjs` replace the bash `dashboard_locale_for` function and `export_dashboard_record` function. `record.import.json` byte-equivalent (modulo timestamp) to v0.4.0.

---

### Task 8.1: locale-map.mjs

**Files:**
- Create: `consumers/protocol-info/post/locale-map.mjs`
- Test: `tests/consumers/protocol-info/locale-map.test.mjs`

- [ ] **Step 1: Test**

```js
import { strict as assert } from 'node:assert';
import { dashboardLocaleFor } from '../../../consumers/protocol-info/post/locale-map.mjs';

export const tests = [
  { name: 'en_US → en', fn: async () => assert.equal(dashboardLocaleFor('en_US'), 'en') },
  { name: 'zh_CN → zh-cn', fn: async () => assert.equal(dashboardLocaleFor('zh_CN'), 'zh-cn') },
  { name: 'zh_HK → zh-hk', fn: async () => assert.equal(dashboardLocaleFor('zh_HK'), 'zh-hk') },
  { name: 'pt_BR → pt-br', fn: async () => assert.equal(dashboardLocaleFor('pt_BR'), 'pt-br') },
  { name: 'pt → pt', fn: async () => assert.equal(dashboardLocaleFor('pt'), 'pt') },
  { name: 'fr_FR → fr', fn: async () => assert.equal(dashboardLocaleFor('fr_FR'), 'fr') },
  { name: 'ja_JP → ja', fn: async () => assert.equal(dashboardLocaleFor('ja_JP'), 'ja') },
  { name: 'unknown XX → xx (lowercase fallback)', fn: async () => assert.equal(dashboardLocaleFor('XX'), 'xx') },
];
```

- [ ] **Step 2: Run, verify fail**

```bash
node tests/run.mjs consumers/protocol-info/locale-map
```

- [ ] **Step 3: Implement**

```js
// consumers/protocol-info/post/locale-map.mjs
// Maps our underscore-mixed-case locale codes to dashboard's hyphen-lowercase format.
// Drops redundant region suffixes when the language has only one variant.
//
// TODO: dashboard supports 21 locales; we currently configure 19. Update when authoritative list arrives.

const EXPLICIT = {
  en_US: 'en',
  fr_FR: 'fr',
  hi_IN: 'hi',
  it_IT: 'it',
  ja_JP: 'ja',
  ko_KR: 'ko',
  th_TH: 'th',
  uk_UA: 'uk',
  pt_BR: 'pt-br',
  zh_CN: 'zh-cn',
  zh_HK: 'zh-hk',
  zh_TW: 'zh-tw',
};
const BARE = new Set(['bn', 'de', 'es', 'id', 'pt', 'ru', 'vi']);

export function dashboardLocaleFor(code) {
  if (EXPLICIT[code]) return EXPLICIT[code];
  if (BARE.has(code)) return code;
  return code.toLowerCase().replace(/_/g, '-');
}
```

- [ ] **Step 4: Run tests**

```bash
node tests/run.mjs consumers/protocol-info/locale-map
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add consumers/protocol-info/post/locale-map.mjs tests/consumers/protocol-info/locale-map.test.mjs
git commit -m "feat(consumer): port dashboard_locale_for to post/locale-map.mjs"
```

---

### Task 8.2: dashboard-export.mjs

**Files:**
- Create: `consumers/protocol-info/post/dashboard-export.mjs`
- Test: `tests/consumers/protocol-info/dashboard-export.test.mjs`

- [ ] **Step 1: Test**

```js
import { strict as assert } from 'node:assert';
import { buildImportFile } from '../../../consumers/protocol-info/post/dashboard-export.mjs';

export const tests = [
  {
    name: 'no translations → 1 record (locale=en, sources stripped)',
    fn: async () => {
      const file = buildImportFile({
        record: { slug: 's', displayName: 'S', sources: ['x'] },
        translations: {},
      });
      assert.equal(file.version, '1.0');
      assert.equal(file.data.length, 1);
      assert.equal(file.data[0].locale, 'en');
      assert.equal('sources' in file.data[0], false);
    },
  },
  {
    name: '2 translations → 3 records with mapped locale codes',
    fn: async () => {
      const file = buildImportFile({
        record: { slug: 's', displayName: 'S', description: 'EN', members: [{ memberName: 'A', memberPosition: 'EN_POS', oneLiner: 'EN_OL' }] },
        translations: {
          zh_CN: { description: 'ZH', members: [{ memberPosition: 'ZH_POS', oneLiner: 'ZH_OL' }] },
          ja_JP: { description: 'JA', members: [{ memberPosition: 'JA_POS', oneLiner: 'JA_OL' }] },
        },
      });
      assert.equal(file.data.length, 3);
      const codes = file.data.map(d => d.locale).sort();
      assert.deepEqual(codes, ['en', 'ja', 'zh-cn']);
      const zh = file.data.find(d => d.locale === 'zh-cn');
      assert.equal(zh.description, 'ZH');
      assert.equal(zh.members[0].memberName, 'A');
      assert.equal(zh.members[0].memberPosition, 'ZH_POS');
    },
  },
];
```

- [ ] **Step 2: Implement**

```js
import { dashboardLocaleFor } from './locale-map.mjs';
import { mergeTranslated } from '../../../framework/i18n-stage.mjs';

export function buildImportFile({ record, translations, sourceLocale = 'en', stripFields = ['sources'] }) {
  const stripped = (r) => {
    const out = { ...r };
    for (const f of stripFields) delete out[f];
    return out;
  };

  const baseEn = { ...stripped(record), locale: sourceLocale };
  const data = [baseEn];
  for (const [code, tr] of Object.entries(translations || {})) {
    const merged = mergeTranslated(stripped(record), tr);
    data.push({ ...merged, locale: dashboardLocaleFor(code) });
  }

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    data,
  };
}
```

- [ ] **Step 3: Run tests**

```bash
node tests/run.mjs consumers/protocol-info/dashboard-export
```

Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add consumers/protocol-info/post/dashboard-export.mjs tests/consumers/protocol-info/dashboard-export.test.mjs
git commit -m "feat(consumer): dashboard-export builds {version, exportedAt, data:[]} envelope"
```

---

### Task 8.3: Wire post-processing into pipeline

**Files:**
- Create: `framework/cli/post.mjs`
- Modify: `consumers/protocol-info/manifest.json` (add post_processing block)
- Modify: `run.sh` (replace bash export functions with cli/post.mjs invocation)

- [ ] **Step 1: Update manifest**

```json
"post_processing": [
  {
    "name": "dashboard-export",
    "module": "./post/dashboard-export.mjs",
    "config": {
      "envelope_version": "1.0",
      "source_locale_dashboard_code": "en",
      "strip_fields": ["sources"]
    }
  }
],
"output": {
  "record_filename": "record.json",
  "findings_filename": "findings.json",
  "changes_filename": "changes.json",
  "gaps_filename": "gaps.json",
  "meta_filename": "meta.json",
  "full_filename": "record.full.json",
  "import_filename": "record.import.json",
  "debug_dir": "_debug"
}
```

- [ ] **Step 2: Implement framework/cli/post.mjs**

```js
// framework/cli/post.mjs — bash-callable post-processing executor.
// Reads record + translations sidecars, calls each post module.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const slugDir = arg('slug-dir');

const manifest = await loadManifest(manifestPath);
const record = JSON.parse(await readFile(join(slugDir, manifest.output?.record_filename || 'record.json'), 'utf8'));

// Collect translations from _debug/i18n/<locale>.json
const i18nDir = join(slugDir, manifest.output?.debug_dir || '_debug', 'i18n');
const translations = {};
try {
  for (const f of await readdir(i18nDir)) {
    if (!f.endsWith('.json') || f.endsWith('.envelope.json')) continue;
    const code = basename(f, '.json');
    if (code === 'failures') continue;
    translations[code] = JSON.parse(await readFile(join(i18nDir, f), 'utf8'));
  }
} catch { /* no i18n run */ }

// Run each post module
for (const p of manifest._abs.post_processing) {
  const mod = await import(pathToFileURL(p.module_abs).href);
  if (typeof mod.buildImportFile === 'function' && p.name === 'dashboard-export') {
    const file = mod.buildImportFile({
      record,
      translations,
      sourceLocale: p.config?.source_locale_dashboard_code || 'en',
      stripFields: p.config?.strip_fields || ['sources'],
    });
    await writeFile(join(slugDir, manifest.output?.import_filename || 'record.import.json'), JSON.stringify(file, null, 2));
  } else if (typeof mod.default === 'function') {
    // Generic post module signature: default({ record, translations, slugDir, manifest, config })
    await mod.default({ record, translations, slugDir, manifest, config: p.config });
  }
}

// Also produce record.full.json (inline i18n map version) when translations exist
if (Object.keys(translations).length > 0) {
  const full = { ...record, i18n: translations };
  await writeFile(join(slugDir, manifest.output?.full_filename || 'record.full.json'), JSON.stringify(full, null, 2));
}

console.error('[post] done');
```

- [ ] **Step 3: Replace bash export logic in run.sh**

Find and remove:
- `dashboard_locale_for()` function
- `export_dashboard_record()` function
- The for-loop block that calls `export_dashboard_record "$_slug"`

Replace the export block with:
```bash
if [[ "$DRY_RUN" -ne 1 ]] && [[ ${#OK_SLUGS[@]} -gt 0 ]]; then
  for _slug in "${OK_SLUGS[@]}"; do
    node "$SCRIPT_DIR/framework/cli/post.mjs" \
      --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
      --slug-dir "$OUT_DIR/$_slug" \
      || echo "[post] $_slug failed; record.import.json may be missing" >&2
  done
  unset _slug
fi
```

- [ ] **Step 4: Smoke test parity**

```bash
./run.sh --i18n zh_CN,ja_JP --display-name "Pendle" --type fixed_rate --slug pendle
OUT=$(ls -1t out | head -1)
jq '{version, n: (.data | length), locales: [.data[].locale]}' out/$OUT/pendle/record.import.json
jq '.i18n | keys' out/$OUT/pendle/record.full.json
```

Expected: 3 records (en + ja + zh-cn); record.full.json has i18n map with both locales.

- [ ] **Step 5: Commit**

```bash
git add framework/cli/post.mjs consumers/protocol-info/manifest.json run.sh
git commit -m "feat: post-processing in Node — dashboard-export + record.full.json

- removes bash dashboard_locale_for() + export_dashboard_record() (~120 lines)
- post.mjs reads manifest.post_processing, dispatches modules
- record.import.json byte-equivalent (modulo exportedAt timestamp)
- record.full.json built generically (record + translations map)"
```

---

# Phase 9 — run.sh shrink + 1.0.0

**Deliverable:** `run.sh` ≤50 lines (only argv parsing + .env loading + exec node). All migrated bash logic removed. Plugin version bumped 0.4.0 → 1.0.0. README + CHANGELOG reflect new architecture.

**Smoke test:** plugin install + slash command + standalone CLI all work end-to-end.

---

### Task 9.1: Build the orchestrator entry

**Files:**
- Create: `framework/cli.mjs`
- Create: `framework/orchestrator.mjs`

The bash run.sh has been progressively delegating to per-stage CLI scripts (fetch, r1, r2, i18n, post). Phase 9 collapses that into a single Node entry that the bash shim exec's.

- [ ] **Step 1: Implement framework/orchestrator.mjs**

```js
// framework/orchestrator.mjs — orchestrates the full pipeline for one or more
// providers. Replaces the bash main loop in run.sh.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './manifest-loader.mjs';
import { runWithLimit } from './parallel-runner.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));

function callCli(cliName, args, opts = {}) {
  return callNode(join(FRAMEWORK_DIR, 'cli', `${cliName}.mjs`), args, opts);
}

function callNode(scriptPath, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn('node', [scriptPath, ...args], {
      stdio: opts.silent ? ['ignore', 'ignore', 'pipe'] : 'inherit',
      env: { ...process.env, ...(opts.env || {}) },
    });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ code, stderr }));
  });
}

function pushOpt(args, flag, value) {
  if (value !== undefined && value !== null && value !== '') args.push(flag, String(value));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function finish(metaPath, meta, result) {
  meta.status = result.status;
  meta.stage = result.stage;
  meta.completed_at = new Date().toISOString();
  await writeJson(metaPath, meta);
  return result;
}

async function summarizeEnvelopes(dir) {
  const summary = { cost_usd: 0, turns: 0, sessions: [] };
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.envelope.json')) continue;
      const env = JSON.parse(await readFile(join(dir, f), 'utf8'));
      summary.cost_usd += Number(env.total_cost_usd || 0);
      summary.turns += Number(env.num_turns || 0);
      if (env.session_id) summary.sessions.push(env.session_id);
    }
  } catch {}
  return summary;
}

export async function runOne({ manifestPath, provider, runDir, options = {} }) {
  const manifest = await loadManifest(manifestPath);
  const slug = provider.slug;
  const slugDir = join(runDir, slug);
  const debugDir = join(slugDir, '_debug');
  await mkdir(join(debugDir, 'r1'), { recursive: true });

  const evidencePath = join(debugDir, 'rootdata.json');   // legacy filename retained
  const recordPath = join(slugDir, 'record.json');
    const findingsPath = join(slugDir, 'findings.json');
    const changesPath = join(slugDir, 'changes.json');
    const gapsPath = join(slugDir, 'gaps.json');
    const handoffPath = join(slugDir, 'handoff_notes.json');
  const metaPath = join(slugDir, manifest.output?.meta_filename || 'meta.json');
  const r1Err = join(debugDir, 'r1.stderr.log');
  const r2Err = join(debugDir, 'r2.stderr.log');
  const diffErr = join(debugDir, 'evidence-diff.stderr.log');
  const normalizeErr = join(debugDir, 'normalize.stderr.log');
  const schemaErr = join(debugDir, 'schema.stderr.log');
  const meta = {
    slug,
    started_at: new Date().toISOString(),
    effective_budgets: options.effectiveBudgets || null,
    r0: null,
    r1: null,
    evidence_diff: null,
    r2: null,
    normalize: null,
    schema: null,
    i18n: null,
    post: null,
  };

  if (options.dryRun) {
    await callCli('r1', [
      '--manifest', manifestPath,
      '--slug', slug,
      '--provider', provider.provider || slug,
      '--display-name', provider.displayName,
      '--type', provider.type,
      '--hints', provider.hints || '',
      '--dry-run',
    ], { silent: false });
    return { slug, status: 'DRY_RUN', stage: 'dry-run' };
  }

  // R0 fetchers
  const fetchArgs = [
    '--manifest', manifestPath,
    '--slug', slug,
    '--display-name', provider.displayName,
    '--hints', provider.hints || '',
    '--output', evidencePath,
  ];
  pushOpt(fetchArgs, '--rootdata-id', provider.rootdataId);
  const r0 = await callCli('fetch', fetchArgs, { silent: true });
  meta.r0 = { status: r0.code === 0 ? 'ok' : 'failed' };
  if (r0.code !== 0) {
    console.error(`[${slug}] fetch failed: ${r0.stderr}`);
    return finish(metaPath, meta, { slug, status: 'CRAWL_FAIL', stage: 'r0' });
  }

  // R1 fan-out
  const r1Args = [
    '--manifest', manifestPath,
    '--slug', slug,
    '--provider', provider.provider || slug,
    '--display-name', provider.displayName,
    '--type', provider.type,
    '--hints', provider.hints || '',
    '--evidence', evidencePath,
    '--record-out', recordPath,
      '--findings-out', findingsPath,
      '--gaps-out', gapsPath,
      '--handoff-out', handoffPath,
      '--debug-dir', join(debugDir, 'r1'),
  ];
  pushOpt(r1Args, '--model', options.model);
  pushOpt(r1Args, '--max-turns', options.maxTurns);
  pushOpt(r1Args, '--max-budget', options.effectiveBudgets?.r1_total);
  const r1 = await callCli('r1', r1Args, { silent: true });
  meta.r1 = {
    status: r1.code === 0 ? 'ok' : 'failed',
    budget_usd: options.effectiveBudgets?.r1_total ?? null,
    ...(await summarizeEnvelopes(join(debugDir, 'r1'))),
  };
  if (r1.code !== 0) {
    console.error(`[${slug}] R1 failed: ${r1.stderr}`);
    return finish(metaPath, meta, { slug, status: 'CRAWL_FAIL', stage: 'r1' });
  }

  // Enrich fetched evidence with deterministic comparisons that require R1.
  const diff = await callCli('evidence-diff', [
    '--evidence-in', evidencePath,
    '--record-in', recordPath,
    '--evidence-out', `${evidencePath}.enriched`,
  ], { silent: true });
  meta.evidence_diff = { status: diff.code === 0 ? 'ok' : 'failed' };
  if (diff.code !== 0) {
    await writeFile(diffErr, diff.stderr || '');
    return finish(metaPath, meta, { slug, status: 'CRAWL_FAIL', stage: 'evidence-diff', recordPath });
  }
  await rename(`${evidencePath}.enriched`, evidencePath);

    // R2+ synthesis/deepening (default-on; bounded by manifest/budget)
  let sessionId = '';
  try {
    const r1MetaEnv = JSON.parse(await readFile(join(debugDir, 'r1', 'metadata.envelope.json'), 'utf8'));
    sessionId = r1MetaEnv.session_id || '';
  } catch {}
  const r2Args = [
    '--manifest', manifestPath,
    '--record-in', recordPath,
      '--findings-in', findingsPath,
      '--gaps-in', gapsPath,
      '--handoff-in', handoffPath,
      '--evidence', evidencePath,
    '--record-out', `${recordPath}.r2`,
    '--findings-out', `${findingsPath}.r2`,
    '--changes-out', `${changesPath}.r2`,
    '--gaps-out', `${gapsPath}.r2`,
    '--debug-dir', debugDir,
  ];
  if (sessionId) r2Args.push('--session', sessionId);
  pushOpt(r2Args, '--model', options.model);
  pushOpt(r2Args, '--max-budget', options.effectiveBudgets?.r2);
  const r2 = await callCli('r2', r2Args, { silent: true });
  meta.r2 = {
    status: r2.code === 0 ? 'ok' : 'failed_nonfatal',
    budget_usd: options.effectiveBudgets?.r2 ?? null,
    ...(await summarizeEnvelopes(debugDir)),
  };
  if (r2.code === 0) {
    // Adopt R2 outputs
    await rename(`${recordPath}.r2`, recordPath);
    await rename(`${findingsPath}.r2`, findingsPath);
    await rename(`${changesPath}.r2`, changesPath);
    await rename(`${gapsPath}.r2`, gapsPath);
  } else {
    console.error(`[${slug}] R2 failed (non-fatal): ${r2.stderr}`);
    await writeFile(changesPath, '[]\n');
  }

  // Deterministic normalizers before validation.
  const norm = await callCli('normalize', [
    '--manifest', manifestPath,
    '--record-in', recordPath,
    '--evidence', evidencePath,
    '--changes-in', changesPath,
    '--gaps-in', gapsPath,
    '--record-out', `${recordPath}.normalized`,
    '--changes-out', `${changesPath}.normalized`,
    '--gaps-out', `${gapsPath}.normalized`,
  ], { silent: true });
  meta.normalize = { status: norm.code === 0 ? 'ok' : 'failed' };
  if (norm.code !== 0) {
    await writeFile(normalizeErr, norm.stderr || '');
    return finish(metaPath, meta, { slug, status: 'SCHEMA_FAIL', stage: 'normalize' });
  }
  await rename(`${recordPath}.normalized`, recordPath);
  await rename(`${changesPath}.normalized`, changesPath);
  await rename(`${gapsPath}.normalized`, gapsPath);

  // Schema validate
  const validate = await callNode(join(FRAMEWORK_DIR, 'schema-validator.mjs'), [
    recordPath, '--schema', manifest._abs.full_schema,
  ], { silent: true });
  meta.schema = { status: validate.code === 0 ? 'ok' : 'failed' };
  if (validate.code !== 0) {
    await writeFile(schemaErr, validate.stderr || '');
    return finish(metaPath, meta, { slug, status: 'SCHEMA_FAIL', stage: 'schema', recordPath });
  }

  // i18n and post-processing only after schema pass.
  if (options.i18nLocales?.length) {
    const i18nArgs = [
      '--manifest', manifestPath,
      '--record', recordPath,
      '--locales', options.i18nLocales.join(','),
      '--output-dir', join(debugDir, 'i18n'),
      '--parallel', String(options.i18nParallel || 8),
    ];
    pushOpt(i18nArgs, '--model', options.i18nModel);
    const i18n = await callCli('i18n', i18nArgs, { silent: true });
    meta.i18n = {
      status: i18n.code === 0 ? 'ok' : 'failed_nonfatal',
      model: options.i18nModel || manifest.i18n?.model_default || null,
      locales_requested: options.i18nLocales,
      ...(await summarizeEnvelopes(join(debugDir, 'i18n'))),
    };
  }
  const post = await callCli('post', ['--manifest', manifestPath, '--slug-dir', slugDir], { silent: true });
  meta.post = { status: post.code === 0 ? 'ok' : 'failed' };
  if (post.code !== 0) {
    return finish(metaPath, meta, { slug, status: 'POST_FAIL', stage: 'post', recordPath });
  }

  return finish(metaPath, meta, { slug, status: 'OK', stage: 'post', recordPath });
}

export async function run({ manifestPath, providers, runDir, parallelism = 1, dryRun = false, options = {} }) {
  if (dryRun) parallelism = 1;
  if (dryRun) options = { ...options, dryRun: true };
  const tasks = providers.map(p => async () => runOne({ manifestPath, provider: p, runDir, options }));
  const results = await runWithLimit(parallelism, tasks);
  return results;
}
```

NOTE: Keep the orchestrator as a thin sequencer that spawns the per-stage CLI
scripts, but do not leave any parsed CLI flag unused. In this task, extend
`r1.mjs` and `r2.mjs` to accept `--model`, `--max-turns`, and `--max-budget`;
extend `fetch.mjs` to accept `--rootdata-id`; preserve `--dry-run` by rendering
prompts without calling Claude; and keep the legacy no-flag i18n behavior
(interactive when stdin is a TTY, skip when headless). Each stage CLI that calls
Claude constructs an in-process `budgetLedger` seeded with its effective stage
cap and passes it to `runSubtask`/`runClaude`, so transient retries consume
remaining stage budget instead of receiving a fresh full cap.

- [ ] **Step 2: Implement framework/cli.mjs (the entry)**

```js
#!/usr/bin/env node
// framework/cli.mjs — single entry for the deep-research framework.
// Parses CLI args (matching the legacy run.sh interface), then delegates
// to orchestrator.run.

import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './orchestrator.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);

// argv parsing: support --batch separators + per-batch flags
const argv = process.argv.slice(2);
const providers = [];
let cur = {};
let parallelism = 1;
let dryRun = false;
let i18nArg = '';
let i18nParallel = 8;
let i18nModel = '';
let model = '';
let maxTurns = 40;
let maxBudget = '2.00';

function flush() {
  if (cur.displayName && cur.type) {
    if (!cur.slug) cur.slug = cur.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!cur.provider) cur.provider = cur.slug;
    providers.push(cur);
  }
  cur = {};
}

for (let idx = 0; idx < argv.length; idx++) {
  const a = argv[idx];
  switch (a) {
    case '--display-name':  cur.displayName = argv[++idx]; break;
    case '--type':          cur.type = argv[++idx]; break;
    case '--slug':          cur.slug = argv[++idx]; break;
    case '--hints':         cur.hints = argv[++idx]; break;
    case '--rootdata-id':   cur.rootdataId = argv[++idx]; break;
    case '--batch':         flush(); break;
    case '--parallel':      parallelism = parseInt(argv[++idx], 10); break;
    case '--i18n':          i18nArg = argv[++idx]; break;
    case '--i18n-parallel': i18nParallel = parseInt(argv[++idx], 10); break;
    case '--i18n-model':    i18nModel = argv[++idx]; break;
    case '--model':         model = argv[++idx]; break;
    case '--max-turns':     maxTurns = parseInt(argv[++idx], 10); break;
    case '--max-budget':    maxBudget = argv[++idx]; break;
    case '--dry-run':       dryRun = true; break;
    case '-h': case '--help':
      console.log('protocol-info — see README for usage');
      process.exit(0);
    default:
      console.error(`unknown arg: ${a}`);
      process.exit(2);
  }
}
flush();

if (providers.length === 0) {
  console.error('error: at least one --display-name + --type required');
  process.exit(1);
}

const manifestPath = resolve(REPO_ROOT, 'consumers/protocol-info/manifest.json');
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
const runDir = resolve(REPO_ROOT, 'out', ts);
await mkdir(runDir, { recursive: true });

console.log('=== Protocol-info crawl ===');
console.log(`Providers:   ${providers.length}`);
console.log(`Parallel:    ${parallelism}`);
console.log(`i18n:        ${i18nArg || '(skip)'}`);
console.log(`Out dir:     ${runDir}`);
console.log('');

const i18nLocales = resolveI18nLocales(i18nArg); // none/empty => []
const effectiveBudgets = computeEffectiveBudgets({ manifestPath, maxBudget });

const results = await run({
  manifestPath,
  providers,
  runDir,
  parallelism,
  dryRun,
  options: {
    model,
    maxTurns,
    effectiveBudgets,
    i18nLocales,
    i18nParallel,
    i18nModel,
  },
});

// Print summary
console.log('\n=== Summary ===');
console.log('slug\tstatus\tstage');
for (const r of results) console.log(`${r.slug}\t${r.status}\t${r.stage}`);
process.exit(results.every(r => r.status === 'OK') ? 0 : 1);
```

Add `resolveI18nLocales(...)` and `computeEffectiveBudgets(...)` in this task.
`computeEffectiveBudgets` enforces the contract that `--max-budget` is a
single-provider total LLM hard cap and records the effective caps in `meta.json`.

- [ ] **Step 3: Test orchestrator end-to-end (single provider)**

```bash
node framework/cli.mjs --i18n none --display-name "Pendle" --type fixed_rate --slug pendle
```

Expected: same output as `./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle`.

- [ ] **Step 4: Commit**

```bash
git add framework/cli.mjs framework/orchestrator.mjs
git commit -m "feat(framework): orchestrator + cli entry

- single Node entry replaces the bash main loop
- argv parsing matches legacy run.sh interface
- delegates to per-stage CLI scripts (fetch/r1/r2/i18n/post)
- run.sh becomes a thin shim in next task"
```

---

### Task 9.2: Shrink run.sh to ≤50 lines

**Files:**
- Replace: `run.sh`

- [ ] **Step 1: Write the new run.sh**

```bash
#!/bin/bash
# run.sh — thin shim for the protocol-info crawler.
# Argv parsing + .env loading happens in framework/cli.mjs.
# This file exists so the plugin entry and standalone CLI invocation
# preserve the familiar `./run.sh ...` UX.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-load .env from one of two locations:
#   1. ./.env (standalone CLI use)
#   2. ~/.config/protocol-info/.env (plugin install — writable across updates)
for _env in "$SCRIPT_DIR/.env" "$HOME/.config/protocol-info/.env"; do
  if [[ -f "$_env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$_env"
    set +a
    break
  fi
done
unset _env

# Fail fast if required tools missing
command -v node    >/dev/null || { echo "node required" >&2; exit 127; }
command -v "${CLAUDE_BIN:-claude}" >/dev/null || { echo "claude CLI required" >&2; exit 127; }

# Hand off to the Node orchestrator
exec node "$SCRIPT_DIR/framework/cli.mjs" "$@"
```

Verify it's ≤50 lines:
```bash
wc -l run.sh
```

- [ ] **Step 2: Smoke test**

```bash
./run.sh --i18n zh_CN,ja_JP --display-name "Pendle" --type fixed_rate --slug pendle
OUT=$(ls -1t out | head -1)
ls out/$OUT/pendle/
```

Expected: identical output to phase-8 invocation.

- [ ] **Step 3: Plugin invocation test**

```bash
# Simulate plugin install path
CLAUDE_PLUGIN_ROOT=/Users/labrinyang/projects/protocol-info bash run.sh --dry-run --display-name "Plugin" --type simple_earn 2>&1 | head -10
```

Expected: banner, no errors.

- [ ] **Step 4: Commit**

```bash
git add run.sh
git commit -m "refactor: shrink run.sh to ≤50 lines

- argv parsing + pipeline orchestration moved to framework/cli.mjs
- run.sh now: load .env, sanity-check binaries, exec node
- preserves ./run.sh ... and /protocol-info ... user-facing UX"
```

---

### Task 9.3: Update plugin metadata + README + CHANGELOG to 1.0.0

**Files:**
- Modify: `.claude-plugin/plugin.json` — version 0.4.0 → 1.0.0
- Modify: `.claude-plugin/marketplace.json` — version 0.4.0 → 1.0.0 (in plugins[0].version)
- Modify: `consumers/protocol-info/manifest.json` — version → 1.0.0
- Modify: `CHANGELOG.md` — add 1.0.0 section
- Modify: `README.md` — refresh directory tree

- [ ] **Step 1: Bump versions**

```bash
sed -i.bak 's/"version": "0.4.0"/"version": "1.0.0"/' .claude-plugin/plugin.json && rm .claude-plugin/plugin.json.bak
sed -i.bak 's/"version": "0.4.0"/"version": "1.0.0"/' .claude-plugin/marketplace.json && rm .claude-plugin/marketplace.json.bak
sed -i.bak 's/"version": "0.5.0-wip"/"version": "1.0.0"/' consumers/protocol-info/manifest.json && rm consumers/protocol-info/manifest.json.bak
```

Verify:
```bash
jq -r '.version' .claude-plugin/plugin.json .claude-plugin/marketplace.json consumers/protocol-info/manifest.json
```

Expected: three `1.0.0` lines.

- [ ] **Step 2: CHANGELOG entry**

Prepend to `CHANGELOG.md` (under the title block):

```markdown
## [1.0.0] — 2026-MM-DD

### Added
- **Deep-research framework** (`framework/`) with reusable consumer adapter pattern.
  protocol-info is the first consumer (`consumers/protocol-info/`).
- **R1 fan-out**: 4 parallel subtasks (metadata / team / funding / audits)
  each with its own slice schema, prompt, and evidence subset. Replaces
  the single big-prompt R1.
- **Multi-source evidence aggregator**: RootData + DeFiLlama fetchers
  called in parallel via `framework/fetcher-dispatcher.mjs`. Fetcher
  interface documented in `framework/FETCHER_INTERFACE.md`.
- **Post-R1 evidence-diff**: deterministic comparison of RootData funding
  evidence against the merged R1 record; conflict signals prioritize R2 instead
  of gating it.
- **Default-on R2+ synthesis/deepening**: whole-record synthesis always runs
  once, can request RootData project/person searches, and may run bounded extra
  rounds while budget and `max_research_rounds` allow.
- **β output**: every subtask returns `{slice, findings, gaps}`.
  New per-slug artifacts: `findings.json` (per-field provenance with
  source URLs and confidence scores), `changes.json` (R2/framework change
  audit), `gaps.json` (unfilled fields with reasons + tried methods).
- **Audit-first R2 guard**: R2+ can make model-judgment changes with
  `changes[]` provenance; uncited high-confidence regressions are suppressed
  or logged for review.
- **Manifest-driven consumer config**: `consumers/protocol-info/manifest.json`
  declares subtasks / fetchers / i18n / post-processing. Framework is
  consumer-agnostic.
- **Custom test runner** (`tests/run.mjs`, zero-dep) and slice-coherence
  check script (`scripts/check-slice-coherence.mjs`).

### Changed
- **`run.sh` is now a ≤50-line shim** that exec's `framework/cli.mjs`.
  Argv parsing + main pipeline live in Node.
- **Output paths unchanged** for users (`out/<ts>/<slug>/{record,record.full,record.import,meta}.json`,
  `_debug/...`). New: `findings.json`, `changes.json`, `gaps.json`.
- Schema `establishment` range matches dashboard (1900–2030).

### Removed
- `preprocess-rootdata.mjs` (moved to `consumers/protocol-info/fetchers/rootdata.mjs`)
- `extract-json.mjs` (moved to `framework/json-extract.mjs`)
- `validate.mjs` (moved to `framework/schema-validator.mjs`)
- ~700 lines of bash from `run.sh` (i18n_dispatch, dashboard_locale_for,
  export_dashboard_record, parallel-runner, R1/R2 invocation glue —
  all now in Node modules).

### Notes
- Plugin install + slash command UX unchanged. Existing user flows work
  without any client-side changes.
- Dashboard supports 21 locales; 19 configured. 2 missing pending the
  authoritative list.
```

- [ ] **Step 3: README directory tree refresh**

In `README.md`, replace the existing "目录结构" block with the post-1.0.0 layout from spec section 3.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json consumers/protocol-info/manifest.json CHANGELOG.md README.md
git commit -m "chore: bump to 1.0.0 + update README + CHANGELOG"
```

---

### Task 9.4: Final end-to-end verification

- [ ] **Step 1: All tests pass**

```bash
node tests/run.mjs
```

Expected: all green.

- [ ] **Step 2: Slice coherence + bash syntax**

```bash
node scripts/check-all.mjs
```

Expected: all green.

- [ ] **Step 3: Real-protocol smoke (no i18n)**

```bash
./run.sh --i18n none --display-name "Pendle" --type fixed_rate --slug pendle
```

Expected: ends with summary, `record.json` populated.

- [ ] **Step 4: Real-protocol smoke (with i18n)**

```bash
./run.sh --i18n zh_CN,ja_JP,en_US --display-name "Pendle" --type fixed_rate --slug pendle
OUT=$(ls -1t out | head -1)
jq '{n: (.data | length), locales: [.data[].locale]}' out/$OUT/pendle/record.import.json
```

Expected: 4 records (en + en + ja + zh-cn — the source `en` plus 3 translated).

Wait: `--i18n en_US` translates English-to-English, which is silly. Adjust: when source locale matches a requested locale, skip translation but still emit the dashboard locale. Edge case; leave for a v1.0.1 patch unless trivial.

- [ ] **Step 5: Plugin install simulation**

```bash
# Simulate installed-via-plugin layout
TMP=$(mktemp -d)
cp -r .claude-plugin commands skills run.sh framework consumers $TMP/
CLAUDE_PLUGIN_ROOT=$TMP bash $TMP/run.sh --dry-run --display-name "PluginCheck" --type simple_earn 2>&1 | head -10
rm -rf $TMP
```

Expected: dry-run banner, no path errors.

- [ ] **Step 6: Commit summary**

```bash
git log --oneline 0.4.0..HEAD
```

Expected: ~30+ commits across 9 phases. All migration phases represented.

- [ ] **Step 7: Tag the release**

```bash
git tag -a v1.0.0 -m "Deep-research framework + protocol-info consumer (β output, R1 fan-out)"
```

(Don't push without user authorization.)

---

## Plan Self-Review

**Spec coverage:**
- §3 Architecture → Phase 1 (bootstrap) + Phase 2 (fetcher dirs) + Phase 9 (final tree) ✓
- §4 Data flow → Phase 2 (R0 packet shape + RootData search channel) + Phase 4 (R1 fan-out + handoffs) + Phase 6 (evidence-diff + default-on R2+ search/deepening + merge) + Phase 7 (i18n) + Phase 8 (export) ✓
- §5 Schemas → Phase 4 (slices) + Phase 5 (findings/gaps universal) ✓
- §6 Manifest → grown incrementally; final shape lands in Phase 7 (i18n) + Phase 8 (post_processing) + Phase 9 (output filenames) ✓
- §7 Error/cost/retry → claude-wrapper one-retry budget guard (Phase 1) + per-subtask isolation (Phase 4 merger) + bounded R2+ rounds from manifest/budget (Phase 6) + always-written meta in orchestrator (Phase 9) ✓
- §8 Testing → tests/run.mjs (Phase 1) + per-module tests in each phase + slice-coherence (Phase 4) + check-all (Phase 1, extended Phase 4) ✓
- §9 Migration phases → 1:1 mapping ✓

**Placeholder scan:** no TBD/"add error handling" placeholders in the plan body. The only TODO-style note is the documented dashboard 21-locale follow-up; it does not block implementation.

**Type consistency:**
- `runWithLimit(limit, tasks, opts?)` — used consistently in Phase 2 (dispatcher), Phase 4 (r1.mjs), Phase 7 (i18n-stage)
- `runSubtask({claudeBin, subtask, systemPrompt, userPrompt, schemaSlice, findingsSchema?, gapsSchema?, changesSchema?, ...})` — extended in Phase 5; supports `handoff_notes` and R2+ `search_requests`; back-compatible
- `mergeSlices(results, opts?)` and `mergeR2(r1, r2)` — distinct functions, both exported from `framework/merger.mjs`
- `runSearchRequests({requests, fetchers, maxQueries, ...})` — executes model-requested structured searches; currently RootData-backed
- `dashboardLocaleFor(code)` — single export, used by `dashboard-export.mjs`
- `extractTranslatable(record, paths)` and `mergeTranslated(base, translated)` — used in `i18n-stage.mjs` and `dashboard-export.mjs`

**Review correction applied:** Task 9.1 now explicitly validates before OK,
passes legacy flags through, runs normalizers before validation, runs i18n
and post-processing only after schema pass, and keeps R2+ default-on instead of
treating evidence-diff as a gate.

---

## Execution Handoff

Plan complete and committed alongside the spec. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task. Reviewer between tasks. ~70 tasks across 9 phases; well-suited because each task has clear deliverable + smoke test, and fresh context per task avoids drift.

**2. Inline Execution** — execute tasks in this session via superpowers:executing-plans. Faster for short tasks but context grows large given the migration's size.

Per the user's standing autonomy grant ("剩下的你可以自己全部都做完决策了"), I'll proceed with **Subagent-Driven**. The user can interject at any phase boundary if direction changes.
