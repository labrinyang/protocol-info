// framework/cli/r1.mjs — bash-callable R1 executor.
// Reads manifest + evidence packet, renders prompt, runs subtask-runner,
// writes envelope + parsed slice to disk.
//
// In phase 3 there's a single subtask 'full'. Phase 4 will dispatch all subtasks.

import { readFile, writeFile } from 'node:fs/promises';
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
const model = arg('model', null);
const claudeBin = process.env.CLAUDE_BIN || 'claude';

if (!manifestPath || !slug || !displayName || !type || !envelopeOut || !sliceOut) {
  console.error('usage: r1.mjs --manifest M --slug S --display-name D --type T [--provider P] [--hints H] [--model M] --evidence E --envelope-out OUT --slice-out OUT2');
  process.exit(2);
}

const manifest = await loadManifest(manifestPath);
const subtask = manifest._abs.subtasks[0];   // phase 3: single subtask
const schemaSlice = JSON.parse(await readFile(subtask.schema_slice_abs, 'utf8'));
const systemPrompt = await readFile(manifest._abs.system_prompt, 'utf8');
const userTmpl = await readFile(subtask.prompt_abs, 'utf8');
// Evidence is loaded defensively (try/catch) because in run.sh's parallel pipeline
// the fetcher writes $rootdata_pkt concurrently with r1.mjs starting; in Phase 3
// the evidence is not injected into the prompt anyway (R1 behavior preserved).
//
// Phase 4 prereq: once subtasks consume evidence_keys to render prompts, run.sh
// must `wait $pid_api` BEFORE invoking r1.mjs, otherwise R1 silently runs with
// empty evidence and produces a degraded record with no audit trail.
let evidence = {};
if (evidencePath) {
  try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
  catch { /* file not yet ready or missing; phase 3 doesn't use it */ }
}

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
  model,
});

if (result.envelope) await writeFile(envelopeOut, JSON.stringify(result.envelope, null, 2));
if (result.ok) {
  await writeFile(sliceOut, JSON.stringify(result.slice, null, 2));
  console.error(`[r1] ok cost=$${result.cost_usd} turns=${result.turns} session=${result.session_id}`);
  process.exit(0);
}
console.error(`[r1] fail: ${result.error}`);
process.exit(1);
