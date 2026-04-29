// Shared structured-LLM facade. Claude remains the default because it provides
// WebFetch/WebSearch. OpenAI-compatible APIs are opt-in per stage.

import { runClaude } from './claude-wrapper.mjs';
import { openAIPricingFromEnv, runOpenAIChatCompletion } from './openai-wrapper.mjs';

const DEFAULT_PROVIDER_CAPABILITIES = {
  claude: ['structured_json', 'web_fetch', 'web_search'],
  openai: ['structured_json'],
};

const DEFAULT_STAGE_POLICIES = {
  r1: {
    allowed_providers: ['claude'],
    required_capabilities: ['structured_json', 'web_fetch', 'web_search'],
  },
  r2: {
    allowed_providers: ['claude', 'openai'],
    required_capabilities: ['structured_json'],
  },
  analyze: {
    allowed_providers: ['claude', 'openai'],
    required_capabilities: ['structured_json'],
  },
  refresh: {
    allowed_providers: ['claude'],
    required_capabilities: ['structured_json', 'web_fetch', 'web_search'],
  },
  'refresh:audits': {
    allowed_providers: ['claude', 'openai'],
    required_capabilities: ['structured_json'],
  },
  i18n: {
    allowed_providers: ['claude', 'openai'],
    required_capabilities: ['structured_json'],
  },
};

function envKey(stage, suffix) {
  return `${String(stage || 'LLM').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;
}

function parentEnvKey(stage, suffix) {
  const parent = String(stage || '').split(/[^A-Za-z0-9]+/).filter(Boolean)[0];
  return parent ? envKey(parent, suffix) : null;
}

function normalizeStage(stage) {
  return String(stage || 'llm').trim().toLowerCase();
}

function manifestProviderConfig(manifest, provider) {
  return manifest?.llm?.providers?.[provider] || null;
}

function manifestStagePolicy(manifest, stage) {
  const stages = manifest?.llm?.stages || {};
  return stages[stage] || stages[stage.split(':')[0]] || null;
}

export function resolveStagePolicy({ stage, manifest = null } = {}) {
  const normalized = normalizeStage(stage);
  const defaultPolicy = DEFAULT_STAGE_POLICIES[normalized]
    || DEFAULT_STAGE_POLICIES[normalized.split(':')[0]]
    || { allowed_providers: ['claude'], required_capabilities: ['structured_json'] };
  return {
    ...defaultPolicy,
    ...(manifestStagePolicy(manifest, normalized) || {}),
  };
}

export function providerCapabilities({ provider, manifest = null } = {}) {
  const normalized = String(provider || 'claude').toLowerCase();
  const fromManifest = manifestProviderConfig(manifest, normalized)?.capabilities;
  if (Array.isArray(fromManifest) && fromManifest.length > 0) return fromManifest;
  return DEFAULT_PROVIDER_CAPABILITIES[normalized] || ['structured_json'];
}

export function assertProviderAllowed({ stage, provider, manifest = null } = {}) {
  const normalizedProvider = String(provider || 'claude').toLowerCase();
  const policy = resolveStagePolicy({ stage, manifest });
  if (Array.isArray(policy.allowed_providers) && !policy.allowed_providers.includes(normalizedProvider)) {
    throw Object.assign(new Error(`LLM provider "${normalizedProvider}" is not allowed for ${normalizeStage(stage)} by stage policy`), {
      kind: 'provider_not_allowed',
      stage: normalizeStage(stage),
      provider: normalizedProvider,
    });
  }
  const capabilities = new Set(providerCapabilities({ provider: normalizedProvider, manifest }));
  const missing = (policy.required_capabilities || []).filter((cap) => !capabilities.has(cap));
  if (missing.length > 0) {
    throw Object.assign(new Error(`LLM provider "${normalizedProvider}" lacks required capabilities for ${normalizeStage(stage)}: ${missing.join(', ')}`), {
      kind: 'provider_capability_missing',
      stage: normalizeStage(stage),
      provider: normalizedProvider,
      missing,
    });
  }
}

export function resolveLLMProvider({ stage, provider = null, env = process.env, fallback = 'claude' } = {}) {
  const parentProviderKey = parentEnvKey(stage, 'LLM_PROVIDER');
  const parentShortKey = parentEnvKey(stage, 'PROVIDER');
  const configured = provider
    || env?.[envKey(stage, 'LLM_PROVIDER')]
    || env?.[envKey(stage, 'PROVIDER')]
    || (parentProviderKey ? env?.[parentProviderKey] : null)
    || (parentShortKey ? env?.[parentShortKey] : null)
    || fallback;
  return String(configured || fallback).trim().toLowerCase();
}

export function resolveOpenAIModel({ stage, model = null, env = process.env, fallback = null } = {}) {
  const parentModelKey = parentEnvKey(stage, 'OPENAI_MODEL');
  const stageModelKey = envKey(stage, 'OPENAI_MODEL');
  const providerModel = model && !/^claude[-_]/i.test(String(model)) ? model : null;
  return providerModel
    || env?.[stageModelKey]
    || (parentModelKey ? env?.[parentModelKey] : null)
    || env?.OPENAI_MODEL
    || fallback;
}

export function resolveOpenAIPricing({ stage, env = process.env, manifest = null } = {}) {
  const normalized = normalizeStage(stage);
  const parent = normalized.split(/[^a-z0-9]+/).filter(Boolean)[0];
  const providerPricing = manifestProviderConfig(manifest, 'openai')?.pricing || null;
  const manifestPricing = providerPricing && Number.isFinite(providerPricing.input_cost_per_1m) && Number.isFinite(providerPricing.output_cost_per_1m)
    ? {
        inputCostPer1M: providerPricing.input_cost_per_1m,
        outputCostPer1M: providerPricing.output_cost_per_1m,
      }
    : null;
  return openAIPricingFromEnv(env, envKey(normalized, 'OPENAI'))
    || (parent ? openAIPricingFromEnv(env, envKey(parent, 'OPENAI')) : null)
    || openAIPricingFromEnv(env)
    || manifestPricing;
}

export async function runStructuredLLM({
  stage = 'llm',
  provider = null,
  manifest = null,
  env = process.env,
  systemPrompt = '',
  userPrompt,
  schemaJson,
  model = null,
  claudeBin = 'claude',
  maxTurns,
  maxBudgetUsd,
  permissionMode = 'bypassPermissions',
  allowedTools = 'WebFetch,WebSearch',
  resumeSession = null,
  budgetLedger = null,
  budgetEnforced = false,
  runClaudeImpl = runClaude,
  runOpenAIImpl = runOpenAIChatCompletion,
}) {
  const selected = resolveLLMProvider({ stage, provider, env });
  assertProviderAllowed({ stage, provider: selected, manifest });
  if (selected === 'claude') {
    return runClaudeImpl({
      claudeBin,
      systemPrompt,
      userPrompt,
      schemaJson,
      maxTurns,
      maxBudgetUsd,
      permissionMode,
      allowedTools,
      resumeSession,
      model,
      budgetLedger,
    });
  }
  if (selected === 'openai') {
    const pricing = resolveOpenAIPricing({ stage, env, manifest });
    const requiresBudgetAccounting = budgetLedger || (budgetEnforced && maxBudgetUsd != null);
    if (requiresBudgetAccounting && !pricing) {
      throw Object.assign(new Error('OpenAI-compatible LLM provider cannot honor USD budget caps without pricing configuration'), {
        kind: 'budget_unknown',
      });
    }
    return runOpenAIImpl({
      systemPrompt,
      userPrompt,
      schemaJson,
      model: resolveOpenAIModel({ stage, model, env }),
      baseUrl: env?.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: env?.OPENAI_API_KEY,
      strictSchema: false,
      pricing,
      maxBudgetUsd: budgetEnforced ? maxBudgetUsd : null,
      budgetLedger,
    });
  }
  throw Object.assign(new Error(`unsupported LLM provider "${selected}" for ${stage}`), {
    kind: 'unsupported_provider',
  });
}
