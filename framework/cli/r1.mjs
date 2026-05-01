// framework/cli/r1.mjs — fan-out R1 executor.
// For each subtask in manifest:
//   - extract relevant evidence subtree
//   - render prompt
//   - call subtask-runner
//   - collect {slice, ok, error, cost, turns, session_id, envelope}
// Then merge slices via merger.mjs and write record + per-subtask envelopes.

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, selectEvidence } from '../manifest-loader.mjs';
import { runSubtask } from '../subtask-runner.mjs';
import { mergeSlices } from '../merger.mjs';
import { runWithLimit } from '../parallel-runner.mjs';
import { clearStaleR1Envelopes, r1EnvelopePath } from '../r1-artifacts.mjs';

// FRAMEWORK_DIR resolves to .../framework/ — dirname() strips r1.mjs, second
// dirname() strips the cli/ directory, leaving the framework root where
// schemas/ lives.
const FRAMEWORK_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const slug = arg('slug');
const provider = arg('provider', slug);
const displayName = arg('display-name');
const hints = arg('hints', '');
const evidencePath = arg('evidence');
const recordOut = arg('record-out');
const debugDir = arg('debug-dir');
const model = arg('model', null);
const llmProvider = arg('llm-provider', null);
const findingsOut = arg('findings-out');
const gapsOut = arg('gaps-out');
const handoffOut = arg('handoff-out');
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const concurrency = parseInt(arg('concurrency', '4'), 10);
const heartbeatMs = parseInt(arg('heartbeat-ms', process.env.R1_HEARTBEAT_MS || '60000'), 10);

// Stage budget caps clamp manifest defaults down. R1 is parallel, so the stage
// total is split across subtasks by their manifest default weights.
const maxTurnsCap = arg('max-turns', null);
const maxBudgetCap = arg('max-budget', null);
const turnsCap = maxTurnsCap ? Math.max(1, parseInt(maxTurnsCap, 10)) : null;
const budgetCap = maxBudgetCap ? Math.max(0, Number(maxBudgetCap)) : null;

if (!manifestPath || !slug || !displayName || !recordOut || !debugDir) {
  console.error('usage: r1.mjs --manifest M --slug S --display-name D [--provider P] [--hints H] [--model M] --evidence E --record-out R --debug-dir D2 [--findings-out F] [--gaps-out G] [--handoff-out H]');
  process.exit(2);
}

await mkdir(debugDir, { recursive: true });

const manifest = await loadManifest(manifestPath);
const systemPrompt = await readFile(manifest._abs.system_prompt, 'utf8');
const findingsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/findings.schema.json'), 'utf8'));
const gapsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/gaps.schema.json'), 'utf8'));
const r1DefaultBudget = (manifest._abs.subtasks || [])
  .reduce((sum, st) => sum + Number(st.max_budget_usd || 0), 0);
await clearStaleR1Envelopes(debugDir, manifest._abs.subtasks || []);

// Evidence is loaded defensively (try/catch) because in run.sh's parallel pipeline
// the fetcher writes $rootdata_pkt concurrently with r1.mjs starting; once Phase 4
// subtasks consume evidence_keys to render prompts, run.sh `wait $pid_api` MUST
// happen BEFORE invoking r1.mjs, otherwise R1 silently runs with empty evidence
// and produces a degraded record with no audit trail.
let evidence = {};
if (evidencePath) {
  try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
  catch { /* fetcher hasn't written packet yet; proceed with empty evidence */ }
}

function render(t, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), t);
}

function nowIso() {
  return new Date().toISOString();
}

function elapsedMsFrom(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Date.now() - t : null;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

const runStartedAt = nowIso();
const statusByName = new Map((manifest._abs.subtasks || []).map(st => [st.name, {
  name: st.name,
  state: 'queued',
  ok: null,
  cost_usd: null,
  turns: null,
  session_id: null,
  pid: null,
  started_at: null,
  spawned_at: null,
  finished_at: null,
  elapsed_ms: null,
  timeout_ms: null,
  error: null,
  error_kind: null,
}]));
let statusWriteQueue = Promise.resolve();
const statusPath = join(debugDir, 'r1-status.json');

function statusSnapshot(extra = {}) {
  const subtasks = (manifest._abs.subtasks || []).map(st => ({ ...(statusByName.get(st.name) || { name: st.name, state: 'unknown' }) }));
  const counts = {
    total: subtasks.length,
    queued: subtasks.filter(s => s.state === 'queued').length,
    running: subtasks.filter(s => s.state === 'running').length,
    ok: subtasks.filter(s => s.ok === true).length,
    failed: subtasks.filter(s => s.ok === false).length,
  };
  return {
    slug,
    stage: 'r1',
    started_at: runStartedAt,
    updated_at: nowIso(),
    elapsed_ms: elapsedMsFrom(runStartedAt),
    concurrency,
    heartbeat_ms: Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : null,
    counts,
    subtasks,
    failed_subtasks: subtasks
      .filter(s => s.ok === false)
      .map(s => ({ name: s.name, reason: s.error || s.error_kind || 'failed', error_kind: s.error_kind || null })),
    ...extra,
  };
}

async function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2));
    await rename(tmpPath, path);
  } catch (err) {
    try { await rm(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function queueStatusWrite(extra = {}) {
  const snapshot = statusSnapshot(extra);
  statusWriteQueue = statusWriteQueue
    .catch(() => {})
    .then(async () => {
      try {
        await writeJsonAtomic(statusPath, snapshot);
      } catch (err) {
        console.error(`[r1] failed to write r1-status.json: ${err.message}`);
      }
    });
  return statusWriteQueue;
}

function updateSubtaskStatus(name, patch) {
  const current = statusByName.get(name) || { name, state: 'unknown' };
  statusByName.set(name, { ...current, ...patch });
  void queueStatusWrite();
}

function logProgress() {
  const snapshot = statusSnapshot();
  const running = snapshot.subtasks
    .filter(s => s.state === 'running')
    .map(s => `${s.name}:${formatElapsed(elapsedMsFrom(s.started_at))}${s.pid ? ` pid=${s.pid}` : ''}`)
    .join(', ') || '-';
  console.error(`[r1] progress ok=${snapshot.counts.ok}/${snapshot.counts.total} failed=${snapshot.counts.failed} running=${running} queued=${snapshot.counts.queued} elapsed=${formatElapsed(snapshot.elapsed_ms)}`);
  void queueStatusWrite();
}

function enrichFailedSubtasks(failedSubtasks) {
  return (failedSubtasks || []).map(f => {
    const status = statusByName.get(f.name) || {};
    return {
      ...f,
      error_kind: status.error_kind || f.error_kind || null,
      pid: status.pid ?? null,
      elapsed_ms: status.elapsed_ms ?? null,
      timeout_ms: status.timeout_ms ?? null,
    };
  });
}

await queueStatusWrite();
const heartbeatTimer = Number.isFinite(heartbeatMs) && heartbeatMs > 0
  ? setInterval(logProgress, heartbeatMs)
  : null;
if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

const tasks = manifest._abs.subtasks.map(st => async () => {
  const startedAt = nowIso();
  updateSubtaskStatus(st.name, {
    state: 'running',
    started_at: startedAt,
    finished_at: null,
    elapsed_ms: null,
    error: null,
    error_kind: null,
  });
  try {
    const slice = JSON.parse(await readFile(st.schema_slice_abs, 'utf8'));
    const userTmpl = await readFile(st.prompt_abs, 'utf8');
    const evSubset = selectEvidence(evidence, st.evidence_keys || []);
    const userPrompt = render(userTmpl, {
      SLUG: slug,
      PROVIDER: provider,
      DISPLAY_NAME: displayName,
      HINTS: hints,
      SCHEMA: JSON.stringify(slice, null, 2),
      EVIDENCE: JSON.stringify(evSubset, null, 2),
    });

    const effSubtask = {
      ...st,
      max_turns: turnsCap != null ? Math.min(st.max_turns, turnsCap) : st.max_turns,
      max_budget_usd: budgetCap != null && r1DefaultBudget > 0
        ? Math.min(st.max_budget_usd, budgetCap * (Number(st.max_budget_usd || 0) / r1DefaultBudget))
        : st.max_budget_usd,
    };
    console.error(`[r1:${st.name}] starting (max_budget=$${effSubtask.max_budget_usd} max_turns=${effSubtask.max_turns})`);
    const r = await runSubtask({
      claudeBin, subtask: effSubtask, systemPrompt, userPrompt, schemaSlice: slice, model,
      findingsSchema, gapsSchema, llmProvider, stage: 'r1', manifest, budgetEnforced: budgetCap != null,
      onSpawn: (info) => updateSubtaskStatus(st.name, {
        pid: info.pid ?? null,
        spawned_at: info.started_at || nowIso(),
        timeout_ms: info.timeout_ms ?? null,
      }),
    });

    if (r.envelope) {
      try {
        await writeFile(r1EnvelopePath(debugDir, st.name), JSON.stringify(r.envelope, null, 2));
      } catch (writeErr) {
        console.error(`[r1:${st.name}] failed to write envelope: ${writeErr.message}`);
        // Envelope write failure is operational, not subtask failure — continue with parsed result.
      }
    }

    const finishedAt = nowIso();
    updateSubtaskStatus(st.name, {
      state: r.ok ? 'ok' : 'failed',
      ok: !!r.ok,
      cost_usd: r.cost_usd ?? 0,
      turns: r.turns ?? 0,
      session_id: r.session_id ?? null,
      finished_at: finishedAt,
      elapsed_ms: elapsedMsFrom(startedAt),
      error: r.error || null,
      error_kind: r.error_kind || null,
      pid: r.pid ?? statusByName.get(st.name)?.pid ?? null,
      timeout_ms: r.timeout_ms ?? statusByName.get(st.name)?.timeout_ms ?? null,
    });
    if (r.ok) {
      console.error(`[r1:${st.name}] done (${formatElapsed(elapsedMsFrom(startedAt))}, cost=$${r.cost_usd ?? 0}, turns=${r.turns ?? 0})`);
    } else {
      console.error(`[r1:${st.name}] failed (${formatElapsed(elapsedMsFrom(startedAt))}, kind=${r.error_kind || 'unknown'}): ${String(r.error || 'unknown').slice(0, 300)}`);
    }
    return { name: st.name, ...r };
  } catch (err) {
    console.error(`[r1:${st.name}] task setup failed: ${err.message}`);
    const failure = {
      name: st.name,
      ok: false,
      error: `task setup: ${err.message}`,
      error_kind: 'task_setup',
      cost_usd: 0,
      turns: 0,
      session_id: null,
      envelope: null,
    };
    updateSubtaskStatus(st.name, {
      state: 'failed',
      ok: false,
      finished_at: nowIso(),
      elapsed_ms: elapsedMsFrom(startedAt),
      error: failure.error,
      error_kind: failure.error_kind,
    });
    return failure;
  }
});

let results;
try {
  results = await runWithLimit(concurrency, tasks);
} catch (err) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const status = statusSnapshot({
    finished_at: nowIso(),
    elapsed_ms: elapsedMsFrom(runStartedAt),
    fatal_error: {
      message: err?.message || String(err),
      error_kind: err?.kind || 'r1_unhandled',
    },
    failed_subtasks: enrichFailedSubtasks(statusSnapshot().failed_subtasks),
  });
  try {
    await statusWriteQueue.catch(() => {});
    await writeJsonAtomic(statusPath, status);
  } catch (writeErr) {
    console.error(`[r1] failed to write r1-status.json: ${writeErr.message}`);
  }
  throw err;
}
if (heartbeatTimer) clearInterval(heartbeatTimer);
const merge = mergeSlices(results, { stage: 'r1' });

await writeFile(recordOut, JSON.stringify(merge.record, null, 2));
if (findingsOut) await writeFile(findingsOut, JSON.stringify(merge.findings, null, 2));
if (gapsOut) await writeFile(gapsOut, JSON.stringify(merge.gaps, null, 2));
if (handoffOut) await writeFile(handoffOut, JSON.stringify(merge.handoff_notes, null, 2));

console.error(`[r1] done — ${results.filter(r => r.ok).length}/${results.length} subtasks ok`);
if (merge.failed_subtasks.length > 0) {
  console.error(`[r1] failed: ${merge.failed_subtasks.map(f => `${f.name} (${f.reason})`).join(', ')}`);
}

const finalFailedSubtasks = enrichFailedSubtasks(merge.failed_subtasks);
const status = {
  ...statusSnapshot({
    finished_at: nowIso(),
    elapsed_ms: elapsedMsFrom(runStartedAt),
    failed_subtasks: finalFailedSubtasks,
  }),
  subtasks: results.map(r => ({
    ...(statusByName.get(r.name) || {}),
    name: r.name,
    ok: r.ok,
    state: r.ok ? 'ok' : 'failed',
    cost_usd: r.cost_usd,
    turns: r.turns,
    session_id: r.session_id,
    error: r.error || null,
    error_kind: r.error_kind || null,
  })),
  failed_subtasks: finalFailedSubtasks,
};
try {
  await statusWriteQueue.catch(() => {});
  await writeJsonAtomic(statusPath, status);
} catch (err) {
  console.error(`[r1] failed to write r1-status.json: ${err.message}`);
  // Status file is telemetry; don't fail the run if it can't be written.
}

process.exit(merge.failed_subtasks.length === results.length ? 1 : 0);  // exit fail only if 0/N succeeded
