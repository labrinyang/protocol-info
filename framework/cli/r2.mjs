// framework/cli/r2.mjs — R2 reconcile/synthesis executor.
// Reads merged R1 record + per-field findings/gaps/handoff + enriched evidence.
// Loops up to manifest.reconcile.max_research_rounds; each round:
//   1. Render reconcile prompt with current state.
//   2. Call subtask-runner with the full schema as outputKey='record'.
//   3. Apply mergeR2 audit-first guard.
//   4. If model emitted search_requests, run them via search-channel and
//      append results to evidence.search_results[]; otherwise stop.
// Each round runs in a fresh Claude session — no session resume.
// (Plan §4337 originally proposed resuming R1's metadata session; this is
// incompatible with fan-out. See memory project_legacy_r2_incompatible_with_fanout.)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';
import { runSubtask } from '../subtask-runner.mjs';
import { mergeR2 } from '../merger.mjs';
import { runSearchRequests } from '../search-channel.mjs';

const FRAMEWORK_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const recordIn = arg('record-in');
const findingsIn = arg('findings-in');
const gapsIn = arg('gaps-in');
const handoffIn = arg('handoff-in', null);
const evidencePath = arg('evidence', null);
const recordOut = arg('record-out');
const findingsOut = arg('findings-out', null);
const changesOut = arg('changes-out', null);
const gapsOut = arg('gaps-out', null);
const debugDir = arg('debug-dir');
const claudeBin = process.env.CLAUDE_BIN || 'claude';

if (!manifestPath || !recordIn || !findingsIn || !gapsIn || !recordOut || !debugDir) {
  console.error('usage: r2.mjs --manifest M --record-in R --findings-in F --gaps-in G [--handoff-in H] [--evidence E] --record-out R2 [--findings-out F2] [--changes-out C2] [--gaps-out G2] --debug-dir D');
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
let handoffNotes = [];
if (handoffIn) {
  try { handoffNotes = JSON.parse(await readFile(handoffIn, 'utf8')); }
  catch { /* missing handoff is fine */ }
}
// Note: if evidence file is absent (e.g., rootdata disabled), proceed with empty evidence.
let evidence = {};
if (evidencePath) {
  try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
  catch { /* no evidence packet; proceed empty */ }
}

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
  max_turns: manifest.reconcile.max_turns ?? 30,
  max_budget_usd: manifest.reconcile.max_budget_usd ?? 1.50,
};

// Lazy-load search fetchers (only those declared with search.enabled=true)
const searchFetchers = [];
for (const f of manifest._abs.fetchers || []) {
  if (!f.search?.enabled) continue;
  try {
    const mod = await import(pathToFileURL(f.module_abs).href);
    if (typeof mod.search === 'function') {
      searchFetchers.push({ name: f.name, search: mod.search });
    } else {
      console.error(`[r2] fetcher ${f.name} declares search but exports no search() function — skipping`);
    }
  } catch (err) {
    console.error(`[r2] failed to load fetcher ${f.name}: ${err.message}`);
  }
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

  console.error(`[r2] round ${round}/${maxRounds} starting (max_budget=$${r2Subtask.max_budget_usd} max_turns=${r2Subtask.max_turns})`);

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
    // resumeSession intentionally omitted — fan-out R1 has no single resumable session.
  });

  if (result.envelope) {
    try {
      await writeFile(join(debugDir, `reconcile.round${round}.envelope.json`), JSON.stringify(result.envelope, null, 2));
    } catch (writeErr) {
      console.error(`[r2] round ${round} envelope write failed: ${writeErr.message}`);
    }
  }

  if (!result.ok) {
    console.error(`[r2] round ${round} failed: ${result.error}; keeping previous state and stopping`);
    break;
  }

  state = mergeR2(state, {
    record: result.slice,
    findings: result.findings,
    changes: result.changes,
    gaps: result.gaps,
  });

  const requests = result.search_requests || [];
  if (requests.length === 0 || round === maxRounds) break;

  console.error(`[r2] round ${round} requested ${requests.length} search(es)`);
  const searchResults = await runSearchRequests({
    requests,
    fetchers: searchFetchers,
    maxQueries: manifest.reconcile.max_search_queries_per_round ?? 4,
    env: process.env,
    logger: console,
    round: round + 1,
  });
  if (searchResults.length === 0) {
    console.error(`[r2] no usable search results — stopping`);
    break;
  }
  evidence = {
    ...evidence,
    search_results: [...(evidence.search_results || []), ...searchResults],
  };
}

// Persist enriched evidence (so subsequent stages and audit can see appended search_results)
if (evidencePath) {
  try { await writeFile(evidencePath, JSON.stringify(evidence, null, 2)); }
  catch (err) { console.error(`[r2] could not write enriched evidence: ${err.message}`); }
}

await writeFile(recordOut, JSON.stringify(state.record, null, 2));
if (findingsOut) await writeFile(findingsOut, JSON.stringify(state.findings, null, 2));
if (changesOut) await writeFile(changesOut, JSON.stringify(state.changes, null, 2));
if (gapsOut) await writeFile(gapsOut, JSON.stringify(state.gaps, null, 2));

console.error(`[r2] done — synthesis complete`);
process.exit(0);
