import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest } from './manifest-loader.mjs';
import { runClaude as defaultRunClaude } from './claude-wrapper.mjs';
import { runSearchRequests as defaultRunSearchRequests } from './search-channel.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));

function tryJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    const r = spawnSync('node', [join(FRAMEWORK_DIR, 'json-extract.mjs')], {
      input: value,
      encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  }
}

function parseProposalEnvelope(envelope) {
  return tryJson(envelope?.structured_output) || tryJson(envelope?.result);
}

function proposalSchema({ findingsSchema, changesSchema, gapsSchema }) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'path', 'reason', 'confidence', 'findings', 'changes', 'gaps'],
    properties: {
      ok: { type: 'boolean' },
      path: { type: 'string', minLength: 1, maxLength: 200 },
      proposed_value: {},
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      source: { type: 'string', maxLength: 500 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      findings: findingsSchema,
      changes: changesSchema,
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
    },
  };
}

function normalizeProposal(proposal, jsonpath) {
  const confidence = Number(proposal?.confidence);
  const normalized = {
    ok: proposal?.ok === true,
    path: proposal?.path || jsonpath,
    reason: proposal?.reason || '',
    source: proposal?.source || '',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    findings: Array.isArray(proposal?.findings) ? proposal.findings : [],
    changes: Array.isArray(proposal?.changes) ? proposal.changes : [],
    gaps: Array.isArray(proposal?.gaps) ? proposal.gaps : [],
    handoff_notes: Array.isArray(proposal?.handoff_notes) ? proposal.handoff_notes : [],
    search_requests: Array.isArray(proposal?.search_requests) ? proposal.search_requests : [],
  };
  if (Object.hasOwn(proposal || {}, 'proposed_value')) {
    normalized.proposed_value = proposal.proposed_value;
  }
  return normalized;
}

function failureProposal(jsonpath, reason) {
  return {
    ok: false,
    path: jsonpath,
    reason,
    source: '',
    confidence: 0,
    findings: [],
    changes: [],
    gaps: [{ field: jsonpath, reason }],
    handoff_notes: [],
    search_requests: [],
  };
}

async function loadSearchFetchers(manifest) {
  const out = [];
  for (const f of manifest._abs.fetchers || []) {
    if (!f.search?.enabled) continue;
    try {
      const mod = await import(pathToFileURL(f.module_abs).href);
      if (typeof mod.search === 'function') {
        out.push({ name: f.name, search: mod.search });
      }
    } catch {
      // Search is opportunistic; the analyzer can still produce a proposal.
    }
  }
  return out;
}

function renderPrompt({ slug, jsonpath, query, currentValue, record, evidence, fullSchema, round }) {
  return [
    'Analyze exactly one protocol-info record field.',
    '',
    `Slug: ${slug}`,
    `JSONPath: ${jsonpath}`,
    `User query: ${query}`,
    `Round: ${round}`,
    '',
    'Rules:',
    '- Return ok=false when the evidence does not support a change.',
    '- When ok=true, proposed_value must be the complete replacement value for JSONPath.',
    '- Do not propose changes for any other path.',
    '- Findings and changes must cite concrete sources when available.',
    '- Use search_requests only when the provided evidence is insufficient and an approved channel can help.',
    '',
    'Current field value:',
    JSON.stringify(currentValue, null, 2),
    '',
    'Current full record:',
    JSON.stringify(record, null, 2),
    '',
    'Available evidence:',
    JSON.stringify(evidence || {}, null, 2),
    '',
    'Full record schema:',
    JSON.stringify(fullSchema, null, 2),
  ].join('\n');
}

export async function analyzeKey({
  slug,
  jsonpath,
  query,
  currentValue,
  record,
  evidence = {},
  manifestPath,
  model = null,
  maxTurns = null,
  maxBudgetUsd = null,
  budgetLedger = null,
  env = process.env,
  logger = console,
  runClaude = defaultRunClaude,
  runSearchRequests = defaultRunSearchRequests,
  searchFetchers = null,
}) {
  if (!slug) throw new Error('analyzeKey: slug is required');
  if (!jsonpath) throw new Error('analyzeKey: jsonpath is required');
  if (!query) throw new Error('analyzeKey: query is required');
  if (!manifestPath) throw new Error('analyzeKey: manifestPath is required');

  const manifest = await loadManifest(manifestPath);
  const fullSchema = JSON.parse(await readFile(manifest._abs.full_schema, 'utf8'));
  const findingsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/findings.schema.json'), 'utf8'));
  const changesSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/changes.schema.json'), 'utf8'));
  const gapsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/gaps.schema.json'), 'utf8'));
  const schemaJson = proposalSchema({ findingsSchema, changesSchema, gapsSchema });
  const fetchers = searchFetchers || await loadSearchFetchers(manifest);
  const rounds = Math.max(1, manifest.reconcile?.max_research_rounds || 2);
  const maxQueries = manifest.reconcile?.max_search_queries_per_round || 4;
  const turns = maxTurns || manifest.reconcile?.max_turns || 30;
  const budget = maxBudgetUsd || manifest.reconcile?.max_budget_usd || 1.5;
  let workingEvidence = evidence || {};
  let lastProposal = null;

  for (let round = 1; round <= rounds; round += 1) {
    const userPrompt = renderPrompt({
      slug,
      jsonpath,
      query,
      currentValue,
      record,
      evidence: workingEvidence,
      fullSchema,
      round,
    });

    let envelope;
    try {
      envelope = await runClaude({
        systemPrompt: '',
        userPrompt,
        schemaJson,
        maxTurns: turns,
        maxBudgetUsd: budget,
        model,
        budgetLedger,
      });
    } catch (err) {
      return failureProposal(jsonpath, `claude invocation failed: ${err.message}`);
    }

    const parsed = parseProposalEnvelope(envelope);
    if (!parsed) {
      return failureProposal(jsonpath, 'no structured proposal recoverable from analyzer envelope');
    }

    lastProposal = normalizeProposal(parsed, jsonpath);
    const requests = lastProposal.search_requests || [];
    if (requests.length === 0 || round === rounds) {
      return lastProposal;
    }

    const searchResults = await runSearchRequests({
      requests,
      fetchers,
      maxQueries,
      env,
      logger,
      round: round + 1,
    });
    if (!searchResults.length) return lastProposal;
    workingEvidence = {
      ...workingEvidence,
      search_results: [...(workingEvidence.search_results || []), ...searchResults],
    };
  }

  return lastProposal || failureProposal(jsonpath, 'analyzer did not return a proposal');
}
