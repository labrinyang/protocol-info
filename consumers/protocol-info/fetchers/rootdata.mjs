#!/usr/bin/env node
//
// rootdata.mjs — Query RootData free-tier API, score member candidates, and
// emit a four-section evidence packet for Round 2 reconciliation.
//
// Two modes:
//   1. Module mode: `import fetch, { search } from '.../rootdata.mjs'` —
//      conforms to framework/FETCHER_INTERFACE.md (default fetch + search).
//   2. CLI mode (legacy, used by run.sh):
//      ROOTDATA_API_KEY=xxx node rootdata.mjs \
//        --slug ethena --display-name "Ethena" \
//        [--rootdata-id 8583] --output /path/to/rootdata-packet.json
//
// CLI exit codes: 0=success, 1=fatal (API error or no project found),
//                 3=invalid args, 4=missing ROOTDATA_API_KEY(S) env var.

import { writeFileSync } from 'node:fs';

const API_BASE = 'https://api.rootdata.com';

// Capture global fetch before our default export shadows the identifier
// inside this module's scope.
const httpFetch = globalThis.fetch;

// ── Public fetcher interface (FETCHER_INTERFACE.md) ────────────────────

// `hints` is accepted but currently unused; reserved for future guided-search use.
export default async function fetch({ slug, displayName, hints, rootdataId, env, logger, fetchImpl, random }) {
  const apiKeys = rootDataApiKeysFromEnv(env);
  if (apiKeys.length === 0) {
    return {
      name: 'rootdata', ok: false, data: null,
      error: 'ROOTDATA_API_KEY(S) not set',
      cost_usd: 0, fetched_at: new Date().toISOString(),
    };
  }
  try {
    const data = await collectRootDataPacket({ slug, displayName, hints, rootdataId, apiKeys, logger, fetchImpl, random });
    return { name: 'rootdata', ok: true, data, cost_usd: 0, fetched_at: new Date().toISOString() };
  } catch (err) {
    logger?.warn?.(`rootdata fetch failed: ${err.message}`);
    return { name: 'rootdata', ok: false, data: null, error: err.message, cost_usd: 0, fetched_at: new Date().toISOString() };
  }
}

export async function search({ query, type = 'project', limit = 5, env, logger, fetchImpl, random }) {
  const apiKeys = rootDataApiKeysFromEnv(env);
  if (apiKeys.length === 0) {
    return { channel: 'rootdata', query, type, ok: false, error: 'ROOTDATA_API_KEY(S) not set', results: [], fetched_at: new Date().toISOString() };
  }
  const rootType = type === 'person' ? 3 : 1;
  try {
    const results = await apiPost('/open/ser_inv', { query, type: rootType }, apiKeys, { logger, fetchImpl, random });
    return {
      channel: 'rootdata',
      query,
      type,
      ok: true,
      results: Array.isArray(results) ? results.slice(0, limit) : [],
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    logger?.warn?.(`rootdata search failed: ${err.message}`);
    return { channel: 'rootdata', query, type, ok: false, error: err.message, results: [], fetched_at: new Date().toISOString() };
  }
}

export function rootDataApiKeysFromEnv(env = process.env) {
  const values = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    for (const part of value.split(/[\s,;]+/)) {
      const trimmed = part.trim();
      if (trimmed) values.push(trimmed);
    }
  };
  add(env?.ROOTDATA_API_KEYS);
  add(env?.ROOTDATA_API_KEY);
  for (const key of Object.keys(env || {}).sort()) {
    if (/^ROOTDATA_API_KEY_\d+$/i.test(key)) add(env[key]);
  }
  return [...new Set(values)];
}

export function hasRootDataApiKeys(env = process.env) {
  return rootDataApiKeysFromEnv(env).length > 0;
}

// ── CLI parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { slug: '', displayName: '', rootdataId: null, output: '' };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--slug':         args.slug = argv[++i]; break;
      case '--display-name': args.displayName = argv[++i]; break;
      case '--rootdata-id':  args.rootdataId = Number(argv[++i]); break;
      case '--output':       args.output = argv[++i]; break;
      default:
        process.stderr.write(`unknown arg: ${argv[i]}\n`);
        process.exit(3);
    }
  }
  if (!args.slug || !args.displayName || !args.output) {
    process.stderr.write('required: --slug, --display-name, --output\n');
    process.exit(3);
  }
  return args;
}

// ── API helpers ───────────────────────────────────────────────────────

function rotateKeys(apiKeys, random = Math.random) {
  const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys].filter(Boolean);
  if (keys.length <= 1) return keys;
  const start = Math.max(0, Math.min(keys.length - 1, Math.floor(random() * keys.length)));
  return keys.slice(start).concat(keys.slice(0, start));
}

function keyLabel(index, total) {
  return total <= 1 ? 'key' : `key ${index + 1}/${total}`;
}

async function apiPostOnce(endpoint, body, apiKey, fetchImpl = httpFetch) {
  const res = await fetchImpl(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
      'language': 'en',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 500);
    const err = new Error(`RootData ${endpoint} HTTP ${res.status}: ${errBody}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (json.result !== 200 && json.code !== 200) {
    const err = new Error(`RootData ${endpoint} result ${json.result ?? json.code}: ${json.message ?? JSON.stringify(json)}`);
    err.result = json.result ?? json.code;
    throw err;
  }
  return json.data;
}

async function apiPost(endpoint, body, apiKeys, { logger, fetchImpl = httpFetch, random = Math.random } = {}) {
  const keys = rotateKeys(Array.isArray(apiKeys) ? apiKeys : [apiKeys], random);
  if (keys.length === 0) throw new Error('ROOTDATA_API_KEY(S) not set');
  let lastErr = null;
  for (let i = 0; i < keys.length; i += 1) {
    try {
      return await apiPostOnce(endpoint, body, keys[i], fetchImpl);
    } catch (err) {
      lastErr = err;
      if (i < keys.length - 1) {
        logger?.warn?.(`RootData ${endpoint} failed with ${keyLabel(i, keys.length)}; trying fallback key: ${err.message}`);
      }
    }
  }
  throw lastErr;
}

async function searchProject(query, apiKeys, opts) {
  return apiPost('/open/ser_inv', { query, type: 1 }, apiKeys, opts);
}

async function searchPeople(query, apiKeys, opts) {
  return apiPost('/open/ser_inv', { query, type: 3 }, apiKeys, opts);
}

async function getItem(projectId, apiKeys, opts) {
  return apiPost('/open/get_item', { project_id: projectId, include_investors: true }, apiKeys, opts);
}

export function extractProviderLogoUrl(item) {
  const value = item?.logo;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return value;
  } catch {
    // Invalid RootData logo.
  }
  return null;
}

// ── Canonical aliases ─────────────────────────────────────────────────

function buildAliases(displayName, projectName, website) {
  const set = new Set();
  const add = (s) => { if (s) set.add(s.toLowerCase().trim()); };
  add(displayName);
  add(projectName);
  if (website) {
    try {
      const host = new URL(website).hostname.replace(/^www\./, '');
      const domain = host.split('.')[0];
      if (domain.length > 2) add(domain);
    } catch { /* ignore bad URL */ }
  }
  return [...set].filter(Boolean);
}

// ── Member candidate scoring (§3.4.1) ─────────────────────────────────

const POSITIVE_PATTERNS = [
  { re: /\b(?:co-?founder|founder|ceo|cto|coo|chief)\b/i, score: 2 },
  { re: /\b(?:head\s+of|lead|president|general\s+counsel|director|vp\s+of)\b/i, score: 1 },
];
const NEGATIVE_PATTERNS = [
  { re: /\b(?:former|ex-|previously)\b/i, score: -2 },
  { re: /\b(?:investor\s+in|angel\s+investor|advisor|backer|board\s+member)\b/i, score: -2 },
];

function scoreWindow(preAlias, postAlias) {
  let positiveSum = 0;
  let hasNegative = false;
  let netScore = 0;
  const full = preAlias + postAlias;
  for (const p of POSITIVE_PATTERNS) {
    if (p.re.test(full)) { positiveSum += p.score; netScore += p.score; }
  }
  // Negative signals only count when they appear BEFORE the alias.
  // "formerly X at Pendle" → previously modifies the Pendle role (降权)
  // "X at Pendle, previously Y at OtherCo" → previously modifies OtherCo (不降权)
  for (const p of NEGATIVE_PATTERNS) {
    if (p.re.test(preAlias)) { hasNegative = true; netScore += p.score; }
  }
  return { positiveSum, hasNegative, netScore };
}

function classifyCandidate(introduce, aliases) {
  if (!introduce) return { bucket: 'exclude', score: 0, window: '' };

  const text = introduce.toLowerCase();
  let bestResult = { positiveSum: 0, hasNegative: false, netScore: -Infinity };
  let bestWindow = '';

  for (const alias of aliases) {
    let idx = -1;
    while ((idx = text.indexOf(alias, idx + 1)) !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + alias.length + 20);
      const preAlias = introduce.slice(start, idx);
      const postAlias = introduce.slice(idx, end);
      const result = scoreWindow(preAlias, postAlias);
      if (result.netScore > bestResult.netScore) {
        bestResult = result;
        bestWindow = introduce.slice(start, end);
      }
    }
  }

  if (bestResult.netScore === -Infinity) {
    return { bucket: 'exclude', score: 0, window: '' };
  }

  const { positiveSum, hasNegative, netScore } = bestResult;
  let bucket;
  if (netScore >= 2 && !hasNegative) {
    bucket = 'likely_member';
  } else if (positiveSum > 0 && positiveSum < 2 && !hasNegative) {
    bucket = 'review';
  } else if (positiveSum > 0 && hasNegative) {
    bucket = 'review';
  } else {
    bucket = 'exclude';
  }

  return { bucket, score: netScore, window: bestWindow };
}

function scoreMemberCandidates(people, aliases) {
  if (!Array.isArray(people)) return [];
  return people
    .map((p) => {
      const intro = (p.introduce || '').slice(0, 200);
      const { bucket, score, window } = classifyCandidate(intro, aliases);
      return {
        name: p.name || p.item_name || '',
        extracted_position: extractPosition(intro, aliases),
        bucket,
        score,
        avatar_url: p.logo || null,
      };
    })
    .filter((c) => c.bucket !== 'exclude')
    .sort((a, b) => b.score - a.score);
}

function extractPosition(introduce, aliases) {
  if (!introduce) return '';
  for (const alias of aliases) {
    const re = new RegExp(`(?:the\\s+)?([A-Za-z &/-]+)\\s+(?:at|of)\\s+${escapeRe(alias)}`, 'i');
    const m = introduce.match(re);
    if (m) return m[1].trim();
  }
  const titleRe = /\b((?:Co-?)?Founder(?:\s*&\s*CEO)?|CEO|CTO|COO|Chief\s+\w+\s+Officer|Head\s+of\s+\w+|General\s+Counsel|President|Director|VP\s+of\s+\w+)/i;
  const m = introduce.match(titleRe);
  return m ? m[1].trim() : '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Validated overrides (§3.4.2) ──────────────────────────────────────

function validateWebsite(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith('http')) return null;
    const host = u.hostname.replace(/^www\./, '');
    if (/^(docs|app|api|cdn|static|beta|staging|dev)\./i.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

function validateXLink(url) {
  if (!url) return null;
  if (/^https?:\/\/(x\.com|twitter\.com)\//i.test(url)) return url;
  return null;
}

// ── Investor normalization (§3.4.3 Step A) ────────────────────────────

function normalizeInvestorName(name) {
  return name
    .toLowerCase()
    .replace(/\s+(capital|ventures|labs|fund|partners|investments|group|network)\s*$/i, '')
    .trim();
}

function separateInvestors(investors) {
  const orgs = [];
  const people = [];
  if (!Array.isArray(investors)) return { orgs, people };
  for (const inv of investors) {
    const name = inv.name || inv.item_name || '';
    if (!name) continue;
    if (inv.type === 3) {
      people.push(name);
    } else {
      orgs.push(name);
    }
  }
  return {
    orgs,
    people,
    orgs_normalized: orgs.map(normalizeInvestorName),
  };
}

// ── Core packet collector ─────────────────────────────────────────────

async function collectRootDataPacket({ slug, displayName, hints, rootdataId, apiKeys, logger, fetchImpl, random }) {
  let projectId = rootdataId;
  let projectSearchHit = null;
  const apiOpts = { logger, fetchImpl, random };

  // Step 1: Resolve project ID if not provided
  if (!projectId) {
    logger?.info?.(`[rootdata] Searching for project "${displayName}"...`);
    const results = await searchProject(displayName, apiKeys, apiOpts);
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error(`No project found for "${displayName}"`);
    }
    const match = results.find(
      (r) => (r.name || r.item_name || '').toLowerCase() === displayName.toLowerCase()
    ) || results[0];
    projectSearchHit = match;
    projectId = match.id || match.project_id;
    if (!projectId) {
      throw new Error(`Could not resolve project ID for "${displayName}"`);
    }
    logger?.info?.(`[rootdata] Resolved "${displayName}" -> ID ${projectId}`);
  }

  // Step 2: Get project detail
  logger?.info?.(`[rootdata] Fetching project detail (ID ${projectId})...`);
  const item = await getItem(projectId, apiKeys, apiOpts);
  if (!item) {
    throw new Error(`get_item returned empty for ID ${projectId}`);
  }

  // Step 3: Build canonical aliases
  const socialMedia = item.social_media || {};
  const aliases = buildAliases(displayName, item.project_name || item.name, socialMedia.website);
  logger?.info?.(`[rootdata] Aliases: ${aliases.join(', ')}`);

  // Step 4: Search for people associated with this project
  logger?.info?.(`[rootdata] Searching for team members...`);
  let people = [];
  try {
    people = await searchPeople(displayName, apiKeys, apiOpts);
  } catch (e) {
    logger?.info?.(`[rootdata] People search failed: ${e.message}`);
  }

  // Step 5: Score member candidates
  const memberCandidates = scoreMemberCandidates(people, aliases);
  logger?.info?.(`[rootdata] Member candidates: ${memberCandidates.length} (${memberCandidates.filter(c => c.bucket === 'likely_member').length} likely)`);

  // Step 6: Build validated overrides
  const validatedOverrides = {};
  const validatedWebsite = validateWebsite(socialMedia.website);
  if (validatedWebsite) validatedOverrides.providerWebsite = validatedWebsite;

  const xUrl = socialMedia.X || socialMedia.x || socialMedia.twitter;
  const validatedX = validateXLink(xUrl);
  if (validatedX) validatedOverrides.providerXLink = validatedX;

  // Step 7: Build anchors
  const anchors = {};
  const providerLogoUrl = extractProviderLogoUrl(item) || extractProviderLogoUrl(projectSearchHit);
  if (providerLogoUrl) anchors.providerLogoUrl = providerLogoUrl;
  if (item.establishment_date) {
    const raw = item.establishment_date;
    const year = /^\d{4}$/.test(raw) ? Number(raw) : new Date(raw).getFullYear();
    if (year && !isNaN(year)) anchors.establishment = { value: year, source: 'rootdata.get_item' };
  }
  if (item.description) anchors.description = item.description;
  if (Array.isArray(item.tags) && item.tags.length > 0) {
    anchors.tags = item.tags.map((t) => (typeof t === 'string' ? t : t.name || t.item_name || '')).filter(Boolean);
  }

  // Step 8: Extract investor data
  const { orgs, people: investorPeople, orgs_normalized } = separateInvestors(item.investors);
  const totalFunding = item.total_funding || item.fundraising_amount || null;
  const apiFunding = {
    total_funding: totalFunding ? `$${totalFunding}` : null,
    investors_orgs: orgs,
    investors_orgs_normalized: orgs_normalized,
    investors_people: investorPeople,
  };

  // Step 9: Assemble packet
  return {
    validated_overrides: validatedOverrides,
    anchors,
    provider_logo_url: providerLogoUrl,
    member_candidates: memberCandidates,
    api_funding: apiFunding,
  };
}

// ── CLI entry (legacy, used by run.sh) ────────────────────────────────

async function main() {
  const apiKeys = rootDataApiKeysFromEnv(process.env);
  if (apiKeys.length === 0) {
    process.stderr.write('ROOTDATA_API_KEY or ROOTDATA_API_KEYS env var is required\n');
    process.exit(4);
  }

  const args = parseArgs(process.argv);
  const { slug, displayName, rootdataId, output } = args;

  const logger = {
    info: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
  };

  const packet = await collectRootDataPacket({
    slug,
    displayName,
    hints: '',
    rootdataId,
    apiKeys,
    logger,
  });

  writeFileSync(output, JSON.stringify(packet, null, 2));
  process.stderr.write(`[rootdata] Packet written to ${output}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[rootdata] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
