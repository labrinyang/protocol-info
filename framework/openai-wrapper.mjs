// OpenAI-compatible Chat Completions wrapper for deterministic structured
// JSON calls. This has no WebFetch/WebSearch equivalent; research-heavy stages
// should opt in explicitly and keep Claude as the default.

const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /\btimeout\b/i,
  /\bECONNRESET\b/,
  /\boverloaded\b/i,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function responseFormatFromSchema(schemaJson, strict) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'protocol_info_structured_output',
      strict,
      schema: schemaJson,
    },
  };
}

function parseStructuredContent(content) {
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('openai structured response missing message content');
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`openai structured response content is not JSON: ${err.message}`);
  }
}

function numericEnv(env, keys) {
  for (const key of keys) {
    const raw = env?.[key];
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

export function openAIPricingFromEnv(env = process.env, prefix = 'OPENAI') {
  const inputCostPer1M = numericEnv(env, [
    `${prefix}_INPUT_COST_PER_1M`,
    `${prefix}_PROMPT_COST_PER_1M`,
  ]);
  const outputCostPer1M = numericEnv(env, [
    `${prefix}_OUTPUT_COST_PER_1M`,
    `${prefix}_COMPLETION_COST_PER_1M`,
  ]);
  const inputCostPer1K = numericEnv(env, [
    `${prefix}_INPUT_COST_PER_1K`,
    `${prefix}_PROMPT_COST_PER_1K`,
  ]);
  const outputCostPer1K = numericEnv(env, [
    `${prefix}_OUTPUT_COST_PER_1K`,
    `${prefix}_COMPLETION_COST_PER_1K`,
  ]);
  const input = inputCostPer1M ?? (inputCostPer1K == null ? null : inputCostPer1K * 1000);
  const output = outputCostPer1M ?? (outputCostPer1K == null ? null : outputCostPer1K * 1000);
  if (input == null || output == null) return null;
  return { inputCostPer1M: input, outputCostPer1M: output };
}

function usageCost(usage, pricing) {
  // Gateway pricing is provider-specific. Preserve token usage and mark USD
  // cost as unknown instead of pretending external calls are free.
  if (!pricing || !usage || typeof usage !== 'object') return null;
  const inputTokens = Number(
    usage.prompt_tokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.inputTokens
    ?? 0
  );
  const outputTokens = Number(
    usage.completion_tokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.outputTokens
    ?? 0
  );
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  return ((inputTokens * pricing.inputCostPer1M) + (outputTokens * pricing.outputCostPer1M)) / 1_000_000;
}

async function requestChatCompletion({
  fetchImpl,
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  schemaJson,
  timeoutMs,
  strictSchema,
}) {
  const endpoint = `${trimSlash(baseUrl)}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'protocol-info/2.1 openai-structured',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt || '' },
          { role: 'user', content: userPrompt },
        ],
        response_format: responseFormatFromSchema(schemaJson, strictSchema),
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }

    if (!response.ok) {
      const msg = body?.error?.message || body?.message || raw || `HTTP ${response.status}`;
      const err = new Error(`openai structured HTTP ${response.status}: ${String(msg).slice(0, 500)}`);
      err.status = response.status;
      err.body = raw;
      throw err;
    }
    if (!body || typeof body !== 'object') {
      throw new Error('openai structured response body is not JSON');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function isTransient(err) {
  const msg = `${err?.status || ''} ${err?.message || ''}`;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(msg));
}

export async function runOpenAIChatCompletion({
  systemPrompt = '',
  userPrompt,
  schemaJson,
  model,
  baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = globalThis.fetch,
  retryOnTransient = true,
  retryDelayMs = 2000,
  timeoutMs = 60_000,
  strictSchema = true,
  pricing = openAIPricingFromEnv(),
  maxBudgetUsd = null,
  budgetLedger = null,
}) {
  if (!userPrompt) throw Object.assign(new Error('runOpenAIChatCompletion: userPrompt is required'), { kind: 'arg_invalid' });
  if (!schemaJson) throw Object.assign(new Error('runOpenAIChatCompletion: schemaJson is required'), { kind: 'arg_invalid' });
  if (!model) throw Object.assign(new Error('OPENAI_MODEL is required for OpenAI-compatible LLM provider'), { kind: 'arg_invalid' });
  if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY is required for OpenAI-compatible LLM provider'), { kind: 'arg_invalid' });
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('fetch is unavailable'), { kind: 'fetch_unavailable' });
  if (budgetLedger && !(budgetLedger.remaining() > 0)) {
    throw Object.assign(new Error('max-budget exhausted before openai-compatible attempt'), { kind: 'budget_exhausted' });
  }

  const attempt = async () => {
    const body = await requestChatCompletion({
      fetchImpl,
      baseUrl,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      schemaJson,
      timeoutMs,
      strictSchema,
    });
    const choice = body.choices?.[0];
    const structured = parseStructuredContent(choice?.message?.content);
    const totalCostUsd = usageCost(body.usage, pricing);
    if (budgetLedger && Number.isFinite(totalCostUsd)) budgetLedger.record(totalCostUsd);
    if (maxBudgetUsd != null && Number.isFinite(totalCostUsd) && totalCostUsd > maxBudgetUsd) {
      throw Object.assign(new Error(`openai-compatible call exceeded max budget: cost=${totalCostUsd} max=${maxBudgetUsd}`), {
        kind: 'budget_exceeded',
      });
    }
    return {
      session_id: body.id || null,
      total_cost_usd: totalCostUsd,
      num_turns: 1,
      structured_output: structured,
      provider: 'openai',
      model: body.model || model,
      usage: body.usage || null,
      finish_reason: choice?.finish_reason || null,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    if (!retryOnTransient || !isTransient(err)) throw err;
    await sleep(retryDelayMs);
    return await attempt();
  }
}
