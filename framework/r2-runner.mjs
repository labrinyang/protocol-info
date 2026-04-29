import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest } from './manifest-loader.mjs';
import { runSubtask as defaultRunSubtask } from './subtask-runner.mjs';
import { mergeR2 } from './merger.mjs';
import { runSearchRequests as defaultRunSearchRequests } from './search-channel.mjs';
import { validateRecord } from './schema-validator.mjs';
import { resolveLLMProvider } from './llm-router.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const R2_ROUTING_ALIASES = new Map([
  ['single_provider', 'single_provider'],
  ['single-provider', 'single_provider'],
  ['single', 'single_provider'],
  ['external_first', 'external_first'],
  ['external-first', 'external_first'],
  ['external_first_with_claude_fallback', 'external_first_with_claude_fallback'],
  ['external-first-with-claude-fallback', 'external_first_with_claude_fallback'],
]);

function render(template, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), template);
}

async function readJsonDefault(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  if (!path) return;
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function loadSearchFetchers(manifest, logger = console) {
  const searchFetchers = [];
  for (const f of manifest._abs.fetchers || []) {
    if (!f.search?.enabled) continue;
    try {
      const mod = await import(pathToFileURL(f.module_abs).href);
      if (typeof mod.search === 'function') {
        searchFetchers.push({ name: f.name, search: mod.search });
      } else {
        logger?.error?.(`[r2] fetcher ${f.name} declares search but exports no search() function — skipping`);
      }
    } catch (err) {
      logger?.error?.(`[r2] failed to load fetcher ${f.name}: ${err.message}`);
    }
  }
  return searchFetchers;
}

export function resolveR2Routing({ routing = null, manifest = null, env = process.env } = {}) {
  const configured = String(routing
    || env?.R2_ROUTING
    || env?.RECONCILE_ROUTING
    || manifest?.reconcile?.routing
    || 'single_provider').trim().toLowerCase();
  const normalized = R2_ROUTING_ALIASES.get(configured);
  if (!normalized) {
    throw Object.assign(new Error(`unsupported R2 routing "${configured}"`), {
      kind: 'arg_invalid',
      routing: configured,
      supported: Array.from(new Set(R2_ROUTING_ALIASES.values())),
    });
  }
  return normalized;
}

function resolveExternalProvider({ llmProvider = null, env = process.env } = {}) {
  return String(
    llmProvider
    || env?.R2_ASSIST_PROVIDER
    || env?.R2_EXTERNAL_PROVIDER
    || env?.R2_LLM_PROVIDER
    || 'openai'
  ).trim().toLowerCase();
}

function resolveFallbackProvider({ env = process.env } = {}) {
  return String(env?.R2_FALLBACK_PROVIDER || 'claude').trim().toLowerCase();
}

function r2AuditGuardGaps(gaps) {
  return (gaps || []).filter((gap) => (
    gap?.stage === 'r2'
    && gap?.subtask === 'reconcile'
    && /(?:uncited|suppressed)/i.test(String(gap?.reason || ''))
  ));
}

const HIGH_RISK_PREFIXES = [
  'members',
  'fundingRounds',
  'audits',
  'description',
  'riskLevel',
];

function highRiskUnverifiedChanges(state) {
  const findings = state?.findings || [];
  const changes = state?.changes || [];
  return changes.filter((change) => {
    const field = String(change?.field || '');
    if (!HIGH_RISK_PREFIXES.some((prefix) => field === prefix || field.startsWith(`${prefix}.`) || field.startsWith(`${prefix}[`))) {
      return false;
    }
    if (change?.source) return false;
    const finding = findings.find((f) => (
      f?.field === field
      || String(f?.field || '').startsWith(`${field}.`)
      || String(f?.field || '').startsWith(`${field}[`)
    ));
    return !(finding && Number(finding.confidence) >= 0.75 && finding.source);
  });
}

export async function evaluateR2ExternalCandidate({
  state,
  fullSchema,
  pendingSearchRequests = [],
} = {}) {
  const reasons = [];
  if ((pendingSearchRequests || []).length > 0) {
    reasons.push(`pending_search_requests:${pendingSearchRequests.length}`);
  }
  const guardGaps = r2AuditGuardGaps(state?.gaps || []);
  if (guardGaps.length > 0) {
    reasons.push(`merge_guard_gaps:${guardGaps.map((g) => `${g.field}:${g.reason}`).join(',')}`);
  }
  const risky = highRiskUnverifiedChanges(state || {});
  if (risky.length > 0) {
    reasons.push(`high_risk_uncited_changes:${risky.map((c) => c.field).join(',')}`);
  }
  if (fullSchema && state?.record) {
    const validation = await validateRecord(state.record, fullSchema);
    if (!validation.ok) {
      reasons.push(`schema_invalid:${validation.errors.slice(0, 5).join('; ')}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

async function runR2Loop({
  manifest,
  fullSchema,
  findingsSchema,
  changesSchema,
  gapsSchema,
  promptTemplate,
  debugDir,
  debugPrefix = '',
  initialState,
  evidence,
  searchFetchers,
  runSubtask,
  runSearchRequests,
  logger,
  claudeBin,
  model,
  provider,
  env,
  baseTurns,
  baseBudget,
  turnsCap,
  budgetCap,
}) {
  const r2Subtask = {
    name: 'reconcile',
    max_turns: turnsCap != null ? Math.min(baseTurns, turnsCap) : baseTurns,
    max_budget_usd: baseBudget,
  };
  let state = {
    record: initialState.record,
    findings: initialState.findings,
    changes: initialState.changes || [],
    gaps: initialState.gaps,
  };
  let evidenceState = evidence || {};
  const maxRounds = manifest.reconcile?.max_research_rounds ?? 3;
  let budgetRemaining = budgetCap;
  let successfulRounds = 0;
  let firstFailure = null;
  let pendingSearchRequests = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundsLeft = maxRounds - round + 1;
    const roundBudget = budgetRemaining != null
      ? Math.min(baseBudget, budgetRemaining / roundsLeft)
      : baseBudget;
    if (!(roundBudget > 0)) {
      firstFailure = firstFailure || 'r2 stage budget exhausted before synthesis';
      break;
    }
    const roundSubtask = { ...r2Subtask, max_budget_usd: roundBudget };
    const userPrompt = render(promptTemplate, {
      RECORD: JSON.stringify(state.record, null, 2),
      FINDINGS: JSON.stringify(state.findings, null, 2),
      GAPS: JSON.stringify(state.gaps, null, 2),
      HANDOFF_NOTES: JSON.stringify(initialState.handoffNotes || [], null, 2),
      EVIDENCE: JSON.stringify(evidenceState, null, 2),
      SCHEMA: JSON.stringify(fullSchema, null, 2),
    });

    logger?.error?.(`[r2]${debugPrefix ? ` ${debugPrefix}` : ''} round ${round}/${maxRounds} starting (max_budget=$${roundSubtask.max_budget_usd} max_turns=${roundSubtask.max_turns})`);

    const result = await runSubtask({
      claudeBin,
      subtask: roundSubtask,
      systemPrompt: '',
      userPrompt,
      schemaSlice: fullSchema,
      findingsSchema,
      changesSchema,
      gapsSchema,
      outputKey: 'record',
      model,
      llmProvider: provider,
      stage: 'r2',
      manifest,
      env,
      budgetEnforced: budgetCap != null,
    });

    if (result.envelope) {
      try {
        const prefix = debugPrefix ? `${debugPrefix}.` : '';
        await writeFile(join(debugDir, `reconcile.${prefix}round${round}.envelope.json`), JSON.stringify(result.envelope, null, 2));
      } catch (writeErr) {
        logger?.error?.(`[r2] round ${round} envelope write failed: ${writeErr.message}`);
      }
    }

    if (!result.ok) {
      logger?.error?.(`[r2]${debugPrefix ? ` ${debugPrefix}` : ''} round ${round} failed: ${result.error}; stopping synthesis`);
      firstFailure = firstFailure || result.error || `round ${round} failed`;
      break;
    }
    if (budgetRemaining != null) {
      if (!Number.isFinite(result.cost_usd)) {
        firstFailure = firstFailure || 'r2 stage budget cannot be updated because provider cost is unknown';
        break;
      }
      budgetRemaining = Math.max(0, budgetRemaining - result.cost_usd);
    }

    state = mergeR2(state, {
      record: result.slice,
      findings: result.findings,
      changes: result.changes,
      gaps: result.gaps,
    });
    successfulRounds += 1;

    const requests = result.search_requests || [];
    pendingSearchRequests = requests;
    if (requests.length === 0) break;
    if (round === maxRounds) break;

    logger?.error?.(`[r2]${debugPrefix ? ` ${debugPrefix}` : ''} round ${round} requested ${requests.length} search(es)`);
    const searchResults = await runSearchRequests({
      requests,
      fetchers: searchFetchers,
      maxQueries: manifest.reconcile?.max_search_queries_per_round ?? 4,
      env,
      logger,
      round: round + 1,
    });
    if (searchResults.length === 0) {
      logger?.error?.('[r2] no usable search results — stopping');
      pendingSearchRequests = [];
      break;
    }
    pendingSearchRequests = [];
    evidenceState = {
      ...evidenceState,
      search_results: [...(evidenceState.search_results || []), ...searchResults],
    };
  }

  return {
    ok: successfulRounds > 0,
    state,
    evidence: evidenceState,
    successfulRounds,
    firstFailure,
    pendingSearchRequests,
  };
}

async function persistSelected({
  result,
  evidencePath,
  recordOut,
  findingsOut,
  changesOut,
  gapsOut,
}) {
  if (evidencePath) await writeJson(evidencePath, result.evidence);
  await writeJson(recordOut, result.state.record);
  await writeJson(findingsOut, result.state.findings);
  await writeJson(changesOut, result.state.changes);
  await writeJson(gapsOut, result.state.gaps);
}

export async function runR2Reconcile({
  manifestPath,
  recordIn,
  findingsIn,
  gapsIn,
  handoffIn = null,
  evidencePath = null,
  recordOut,
  findingsOut = null,
  changesOut = null,
  gapsOut = null,
  debugDir,
  model = null,
  llmProvider = null,
  routing = null,
  maxTurnsCap = null,
  maxBudgetCap = null,
  claudeBin = process.env.CLAUDE_BIN || 'claude',
  env = process.env,
  logger = console,
  runSubtask = defaultRunSubtask,
  runSearchRequests = defaultRunSearchRequests,
  searchFetchers = null,
} = {}) {
  if (!manifestPath || !recordIn || !findingsIn || !gapsIn || !recordOut || !debugDir) {
    throw Object.assign(new Error('runR2Reconcile: manifestPath, recordIn, findingsIn, gapsIn, recordOut, debugDir are required'), {
      kind: 'arg_invalid',
    });
  }

  await mkdir(debugDir, { recursive: true });
  const manifest = await loadManifest(manifestPath);

  const r1Record = await readJsonDefault(recordIn, null);
  const r1Findings = await readJsonDefault(findingsIn, []);
  const r1Gaps = await readJsonDefault(gapsIn, []);
  const handoffNotes = await readJsonDefault(handoffIn, []);

  if (!manifest.reconcile?.enabled) {
    logger?.error?.('[r2] manifest.reconcile.enabled is false; copying R1 outputs unchanged');
    await writeJson(recordOut, r1Record);
    await writeJson(findingsOut, r1Findings);
    await writeJson(changesOut, []);
    await writeJson(gapsOut, r1Gaps);
    return { ok: true, selected: 'disabled', routing: 'disabled' };
  }

  let evidence = await readJsonDefault(evidencePath, {});
  const fullSchema = JSON.parse(await readFile(manifest._abs.full_schema, 'utf8'));
  const findingsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/findings.schema.json'), 'utf8'));
  const changesSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/changes.schema.json'), 'utf8'));
  const gapsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/gaps.schema.json'), 'utf8'));
  const webPrompt = await readFile(manifest._abs.reconcile_prompt, 'utf8');
  const evidencePrompt = manifest._abs.reconcile_evidence_prompt
    ? await readFile(manifest._abs.reconcile_evidence_prompt, 'utf8')
    : webPrompt;
  const turnsCap = maxTurnsCap ? Math.max(1, parseInt(maxTurnsCap, 10)) : null;
  const budgetCap = maxBudgetCap ? Math.max(0, Number(maxBudgetCap)) : null;
  const baseTurns = manifest.reconcile.max_turns ?? 30;
  const baseBudget = manifest.reconcile.max_budget_usd ?? 1.50;
  const loadedSearchFetchers = searchFetchers || await loadSearchFetchers(manifest, logger);
  const initialState = {
    record: r1Record,
    findings: r1Findings,
    changes: [],
    gaps: r1Gaps,
    handoffNotes,
  };
  const selectedRouting = resolveR2Routing({ routing, manifest, env });

  const common = {
    manifest,
    fullSchema,
    findingsSchema,
    changesSchema,
    gapsSchema,
    debugDir,
    initialState,
    searchFetchers: loadedSearchFetchers,
    runSubtask,
    runSearchRequests,
    logger,
    claudeBin,
    model,
    env,
    baseTurns,
    baseBudget,
    turnsCap,
    budgetCap,
  };

  const routeMeta = {
    routing: selectedRouting,
    selected: null,
    attempts: [],
  };

  const externalFirst = selectedRouting === 'external_first'
    || selectedRouting === 'external_first_with_claude_fallback';

  if (!externalFirst) {
    const singleProvider = resolveLLMProvider({ stage: 'r2', provider: llmProvider, env });
    const singlePrompt = singleProvider === 'openai' ? evidencePrompt : webPrompt;
    const result = await runR2Loop({
      ...common,
      promptTemplate: singlePrompt,
      evidence,
      provider: llmProvider,
      debugPrefix: '',
    });
    routeMeta.selected = result.ok ? 'single_provider' : null;
    routeMeta.attempts.push({
      route: 'single_provider',
      provider: singleProvider,
      prompt_mode: singleProvider === 'openai' ? 'evidence' : 'web',
      ok: result.ok,
      failure: result.firstFailure || null,
    });
    await writeJson(join(debugDir, 'reconcile.route.json'), routeMeta);
    if (!result.ok) {
      return { ok: false, routing: selectedRouting, selected: null, firstFailure: result.firstFailure };
    }
    await persistSelected({ result, evidencePath, recordOut, findingsOut, changesOut, gapsOut });
    return { ok: true, routing: selectedRouting, selected: 'single_provider', result };
  }

  const externalProvider = resolveExternalProvider({ llmProvider, env });
  logger?.error?.(`[r2] external-first started: provider=${externalProvider}`);
  const external = await runR2Loop({
    ...common,
    promptTemplate: evidencePrompt,
    evidence,
    provider: externalProvider,
    debugPrefix: 'external',
  });
  evidence = external.evidence;
  const gate = external.ok
    ? await evaluateR2ExternalCandidate({
        state: external.state,
        fullSchema,
        pendingSearchRequests: external.pendingSearchRequests,
      })
    : { ok: false, reasons: [external.firstFailure || 'external_r2_failed'] };
  routeMeta.attempts.push({
    route: 'external',
    provider: externalProvider,
    ok: external.ok,
    gate,
    failure: external.firstFailure || null,
  });

  if (external.ok && gate.ok) {
    routeMeta.selected = 'external';
    await writeJson(join(debugDir, 'reconcile.route.json'), routeMeta);
    await persistSelected({ result: external, evidencePath, recordOut, findingsOut, changesOut, gapsOut });
    return { ok: true, routing: selectedRouting, selected: 'external', result: external, gate };
  }

  const withFallback = selectedRouting === 'external_first_with_claude_fallback';
  if (!withFallback) {
    routeMeta.selected = null;
    await writeJson(join(debugDir, 'reconcile.route.json'), routeMeta);
    if (evidencePath) await writeJson(evidencePath, evidence);
    return { ok: false, routing: selectedRouting, selected: null, firstFailure: gate.reasons.join('; ') };
  }

  const fallbackProvider = resolveFallbackProvider({ env });
  logger?.error?.(`[r2] external result rejected; falling back to ${fallbackProvider}: ${gate.reasons.join('; ')}`);
  const fallback = await runR2Loop({
    ...common,
    promptTemplate: webPrompt,
    evidence,
    provider: fallbackProvider,
    debugPrefix: 'fallback',
  });
  routeMeta.attempts.push({
    route: 'fallback',
    provider: fallbackProvider,
    ok: fallback.ok,
    failure: fallback.firstFailure || null,
  });
  if (!fallback.ok) {
    routeMeta.selected = null;
    await writeJson(join(debugDir, 'reconcile.route.json'), routeMeta);
    if (evidencePath) await writeJson(evidencePath, fallback.evidence);
    return {
      ok: false,
      routing: selectedRouting,
      selected: null,
      firstFailure: fallback.firstFailure || gate.reasons.join('; '),
    };
  }
  routeMeta.selected = 'fallback';
  await writeJson(join(debugDir, 'reconcile.route.json'), routeMeta);
  await persistSelected({ result: fallback, evidencePath, recordOut, findingsOut, changesOut, gapsOut });
  return { ok: true, routing: selectedRouting, selected: 'fallback', result: fallback, gate };
}
