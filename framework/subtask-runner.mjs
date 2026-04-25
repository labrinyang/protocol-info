// Runs one subtask: render prompt → call claude → parse structured_output → return slice.
// α-shape: returns just `slice`. β-shape (slice + findings + gaps) added in phase 5.

import { runClaude } from './claude-wrapper.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
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
      error_kind: err.kind ?? null,
      cost_usd: 0, turns: 0, envelope: null, session_id: null,
    };
  }

  const slice = parseEnvelope(envelope);
  if (!slice) {
    let errMsg = 'no structured_output recoverable from envelope';
    if (envelope.is_error && typeof envelope.result === 'string') {
      errMsg = `claude api error: ${envelope.result.slice(0, 300)}`;
    }
    return {
      ok: false, error: errMsg,
      cost_usd: envelope.total_cost_usd ?? 0, turns: envelope.num_turns ?? 0,
      session_id: envelope.session_id ?? null, envelope,
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
