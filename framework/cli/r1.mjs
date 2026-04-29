// framework/cli/r1.mjs — fan-out R1 executor.
// For each subtask in manifest:
//   - extract relevant evidence subtree
//   - render prompt
//   - call subtask-runner
//   - collect {slice, ok, error, cost, turns, session_id, envelope}
// Then merge slices via merger.mjs and write record + per-subtask envelopes.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, selectEvidence } from '../manifest-loader.mjs';
import { runSubtask } from '../subtask-runner.mjs';
import { mergeSlices } from '../merger.mjs';
import { runWithLimit } from '../parallel-runner.mjs';

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
// `type` is OPTIONAL: the metadata subtask infers it from evidence. When
// supplied via --type, fold into hints as a soft preference — the prompt
// already documents the override semantics for type tokens in {{HINTS}}.
const type = arg('type', '');
const rawHints = arg('hints', '');
const hints = type
  ? (rawHints ? `${rawHints}; type=${type}` : `type=${type}`)
  : rawHints;
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

// Stage budget caps clamp manifest defaults down. R1 is parallel, so the stage
// total is split across subtasks by their manifest default weights.
const maxTurnsCap = arg('max-turns', null);
const maxBudgetCap = arg('max-budget', null);
const turnsCap = maxTurnsCap ? Math.max(1, parseInt(maxTurnsCap, 10)) : null;
const budgetCap = maxBudgetCap ? Math.max(0, Number(maxBudgetCap)) : null;

if (!manifestPath || !slug || !displayName || !recordOut || !debugDir) {
  console.error('usage: r1.mjs --manifest M --slug S --display-name D [--type T] [--provider P] [--hints H] [--model M] --evidence E --record-out R --debug-dir D2 [--findings-out F] [--gaps-out G] [--handoff-out H]');
  process.exit(2);
}

await mkdir(debugDir, { recursive: true });

const manifest = await loadManifest(manifestPath);
const systemPrompt = await readFile(manifest._abs.system_prompt, 'utf8');
const findingsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/findings.schema.json'), 'utf8'));
const gapsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/gaps.schema.json'), 'utf8'));
const r1DefaultBudget = (manifest._abs.subtasks || [])
  .reduce((sum, st) => sum + Number(st.max_budget_usd || 0), 0);

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

const tasks = manifest._abs.subtasks.map(st => async () => {
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
    });

    if (r.envelope) {
      try {
        await writeFile(join(debugDir, `${st.name}.envelope.json`), JSON.stringify(r.envelope, null, 2));
      } catch (writeErr) {
        console.error(`[r1:${st.name}] failed to write envelope: ${writeErr.message}`);
        // Envelope write failure is operational, not subtask failure — continue with parsed result.
      }
    }

    return { name: st.name, ...r };
  } catch (err) {
    console.error(`[r1:${st.name}] task setup failed: ${err.message}`);
    return {
      name: st.name,
      ok: false,
      error: `task setup: ${err.message}`,
      error_kind: 'task_setup',
      cost_usd: 0,
      turns: 0,
      session_id: null,
      envelope: null,
    };
  }
});

const results = await runWithLimit(concurrency, tasks);
const merge = mergeSlices(results, { stage: 'r1' });

await writeFile(recordOut, JSON.stringify(merge.record, null, 2));
if (findingsOut) await writeFile(findingsOut, JSON.stringify(merge.findings, null, 2));
if (gapsOut) await writeFile(gapsOut, JSON.stringify(merge.gaps, null, 2));
if (handoffOut) await writeFile(handoffOut, JSON.stringify(merge.handoff_notes, null, 2));

console.error(`[r1] done — ${results.filter(r => r.ok).length}/${results.length} subtasks ok`);
if (merge.failed_subtasks.length > 0) {
  console.error(`[r1] failed: ${merge.failed_subtasks.map(f => `${f.name} (${f.reason})`).join(', ')}`);
}

const status = {
  subtasks: results.map(r => ({ name: r.name, ok: r.ok, cost_usd: r.cost_usd, turns: r.turns, session_id: r.session_id, error: r.error || null })),
  failed_subtasks: merge.failed_subtasks,
};
try {
  await writeFile(join(debugDir, 'r1-status.json'), JSON.stringify(status, null, 2));
} catch (err) {
  console.error(`[r1] failed to write r1-status.json: ${err.message}`);
  // Status file is telemetry; don't fail the run if it can't be written.
}

process.exit(merge.failed_subtasks.length === results.length ? 1 : 0);  // exit fail only if 0/N succeeded
