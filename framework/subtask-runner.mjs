// Runs one subtask: render prompt → call configured structured LLM → parse
// structured_output → return slice.
// α-shape: returns just `slice`. β-shape (slice + findings + gaps) added in phase 5.

import { resolveLLMProvider, runStructuredLLM } from './llm-router.mjs';
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
  budgetLedger = null,
  budgetEnforced = false,
  llmProvider = null,
  stage = 'r1',
  manifest = null,
  env = process.env,
  runLLM = runStructuredLLM,
}) {
  const useBeta = findingsSchema && gapsSchema;
  const schemaJson = useBeta
    ? buildUnionSchema(outputKey, schemaSlice, findingsSchema, gapsSchema, changesSchema)
    : schemaSlice;

  let envelope;
  try {
    envelope = await runLLM({
      stage,
      provider: llmProvider,
      manifest,
      env,
      claudeBin,
      systemPrompt,
      userPrompt,
      schemaJson,
      maxTurns: subtask.max_turns,
      maxBudgetUsd: subtask.max_budget_usd,
      resumeSession,
      model,
      budgetLedger,
      budgetEnforced,
    });
  } catch (err) {
    const provider = resolveLLMProvider({ stage, provider: llmProvider, env });
    const label = String(provider).toLowerCase() === 'claude' ? 'claude' : 'llm';
    return {
      ok: false, error: `${label} invocation failed: ${err.message}`,
      error_kind: err.kind ?? null,
      cost_usd: 0, turns: 0, envelope: null, session_id: null,
    };
  }

  const parsed = parseEnvelope(envelope);
  if (!parsed) {
    let errMsg = 'no structured_output recoverable from envelope';
    if (envelope.is_error && typeof envelope.result === 'string') {
      errMsg = `claude api error: ${envelope.result.slice(0, 300)}`;
    }
    return {
      ok: false, error: errMsg,
      error_kind: null,
      cost_usd: Object.hasOwn(envelope, 'total_cost_usd') ? envelope.total_cost_usd : 0,
      turns: envelope.num_turns ?? 0,
      session_id: envelope.session_id ?? null,
      envelope,
    };
  }

  if (useBeta) {
    if (!parsed[outputKey] || !Array.isArray(parsed.findings) || !Array.isArray(parsed.gaps)) {
      return {
        ok: false, error: `β output missing ${outputKey}/findings/gaps`,
        error_kind: null,
        cost_usd: Object.hasOwn(envelope, 'total_cost_usd') ? envelope.total_cost_usd : 0,
        turns: envelope.num_turns ?? 0,
        session_id: envelope.session_id ?? null,
        envelope,
      };
    }
    if (changesSchema && !Array.isArray(parsed.changes)) {
      return {
        ok: false, error: 'β output missing changes',
        error_kind: null,
        cost_usd: Object.hasOwn(envelope, 'total_cost_usd') ? envelope.total_cost_usd : 0,
        turns: envelope.num_turns ?? 0,
        session_id: envelope.session_id ?? null,
        envelope,
      };
    }
    return {
      ok: true,
      slice: parsed[outputKey],
      findings: parsed.findings,
      changes: parsed.changes || [],
      gaps: parsed.gaps,
      handoff_notes: parsed.handoff_notes || [],
      search_requests: parsed.search_requests || [],
      cost_usd: Object.hasOwn(envelope, 'total_cost_usd') ? envelope.total_cost_usd : 0,
      turns: envelope.num_turns ?? 0,
      session_id: envelope.session_id ?? null,
      envelope,
    };
  }

  // α-shape (slice only)
  return {
    ok: true,
    slice: parsed,
    cost_usd: Object.hasOwn(envelope, 'total_cost_usd') ? envelope.total_cost_usd : 0,
    turns: envelope.num_turns ?? 0,
    session_id: envelope.session_id ?? null,
    envelope,
  };
}
