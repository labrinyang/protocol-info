// framework/cli/r1.mjs — fan-out R1 executor.
// For each subtask in manifest:
//   - extract relevant evidence subtree
//   - render prompt
//   - call subtask-runner
//   - collect {slice, ok, error, cost, turns, session_id, envelope}
// Then merge slices via merger.mjs and write record + per-subtask envelopes.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
// `type` is OPTIONAL: Phase 4 metadata subtask infers it from evidence.
// Accepted as a soft hint; when supplied it's surfaced in {{HINTS}} only,
// never substituted as a fact in metadata's prompt.
const type = arg('type', '');
const hints = arg('hints', '');
const evidencePath = arg('evidence');
const recordOut = arg('record-out');
const debugDir = arg('debug-dir');
const model = arg('model', null);
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const concurrency = parseInt(arg('concurrency', '4'), 10);

if (!manifestPath || !slug || !displayName || !recordOut || !debugDir) {
  console.error('usage: r1.mjs --manifest M --slug S --display-name D [--type T] [--provider P] [--hints H] [--model M] --evidence E --record-out R --debug-dir D2');
  process.exit(2);
}

await mkdir(debugDir, { recursive: true });

const manifest = await loadManifest(manifestPath);
const systemPrompt = await readFile(manifest._abs.system_prompt, 'utf8');

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
      TYPE: type,    // empty string if --type not passed; metadata template doesn't use {{TYPE}} anyway
      HINTS: hints,
      SCHEMA: JSON.stringify(slice, null, 2),
      EVIDENCE: JSON.stringify(evSubset, null, 2),
    });

    console.error(`[r1:${st.name}] starting (max_budget=$${st.max_budget_usd} max_turns=${st.max_turns})`);
    const r = await runSubtask({
      claudeBin, subtask: st, systemPrompt, userPrompt, schemaSlice: slice, model,
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
try {
  await writeFile(join(debugDir, 'r1-status.json'), JSON.stringify(status, null, 2));
} catch (err) {
  console.error(`[r1] failed to write r1-status.json: ${err.message}`);
  // Status file is telemetry; don't fail the run if it can't be written.
}

process.exit(merge.failed_subtasks.length === results.length ? 1 : 0);  // exit fail only if 0/N succeeded
