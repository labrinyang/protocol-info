#!/usr/bin/env node
//
// preprocess-rootdata.mjs — Query RootData free-tier API, score member
// candidates, and emit a four-section evidence packet for Round 2 reconciliation.
//
// Usage:
//   ROOTDATA_API_KEY=xxx node preprocess-rootdata.mjs \
//     --slug ethena --display-name "Ethena" \
//     [--rootdata-id 8583] --output /path/to/rootdata-packet.json
//
// Exit codes: 0=success, 1=API error, 2=no project found, 3=invalid args,
//             4=missing ROOTDATA_API_KEY env var.

import { writeFileSync } from 'node:fs';

const API_BASE = 'https://api.rootdata.com';

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

async function apiPost(endpoint, body, apiKey) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
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
    throw new Error(`RootData ${endpoint} HTTP ${res.status}: ${errBody}`);
  }
  const json = await res.json();
  if (json.result !== 200 && json.code !== 200) {
    throw new Error(`RootData ${endpoint} result ${json.result ?? json.code}: ${json.message ?? JSON.stringify(json)}`);
  }
  return json.data;
}

async function searchProject(query, apiKey) {
  return apiPost('/open/ser_inv', { query, type: 1 }, apiKey);
}

async function searchPeople(query, apiKey) {
  return apiPost('/open/ser_inv', { query, type: 3 }, apiKey);
}

async function getItem(projectId, apiKey) {
  return apiPost('/open/get_item', { project_id: projectId, include_investors: true }, apiKey);
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

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ROOTDATA_API_KEY;
  if (!apiKey) {
    process.stderr.write('ROOTDATA_API_KEY env var is required\n');
    process.exit(4);
  }

  const args = parseArgs(process.argv);
  const { slug, displayName, output } = args;
  let projectId = args.rootdataId;

  // Step 1: Resolve project ID if not provided
  if (!projectId) {
    process.stderr.write(`[rootdata] Searching for project "${displayName}"...\n`);
    const results = await searchProject(displayName, apiKey);
    if (!Array.isArray(results) || results.length === 0) {
      process.stderr.write(`[rootdata] No project found for "${displayName}"\n`);
      process.exit(2);
    }
    const match = results.find(
      (r) => (r.name || r.item_name || '').toLowerCase() === displayName.toLowerCase()
    ) || results[0];
    projectId = match.id || match.project_id;
    if (!projectId) {
      process.stderr.write(`[rootdata] Could not resolve project ID for "${displayName}"\n`);
      process.exit(2);
    }
    process.stderr.write(`[rootdata] Resolved "${displayName}" -> ID ${projectId}\n`);
  }

  // Step 2: Get project detail
  process.stderr.write(`[rootdata] Fetching project detail (ID ${projectId})...\n`);
  const item = await getItem(projectId, apiKey);
  if (!item) {
    process.stderr.write(`[rootdata] get_item returned empty for ID ${projectId}\n`);
    process.exit(1);
  }

  // Step 3: Build canonical aliases
  const socialMedia = item.social_media || {};
  const aliases = buildAliases(displayName, item.project_name || item.name, socialMedia.website);
  process.stderr.write(`[rootdata] Aliases: ${aliases.join(', ')}\n`);

  // Step 4: Search for people associated with this project
  process.stderr.write(`[rootdata] Searching for team members...\n`);
  let people = [];
  try {
    people = await searchPeople(displayName, apiKey);
  } catch (e) {
    process.stderr.write(`[rootdata] People search failed: ${e.message}\n`);
  }

  // Step 5: Score member candidates
  const memberCandidates = scoreMemberCandidates(people, aliases);
  process.stderr.write(`[rootdata] Member candidates: ${memberCandidates.length} (${memberCandidates.filter(c => c.bucket === 'likely_member').length} likely)\n`);

  // Step 6: Build validated overrides
  const validatedOverrides = {};
  const validatedWebsite = validateWebsite(socialMedia.website);
  if (validatedWebsite) validatedOverrides.providerWebsite = validatedWebsite;

  const xUrl = socialMedia.X || socialMedia.x || socialMedia.twitter;
  const validatedX = validateXLink(xUrl);
  if (validatedX) validatedOverrides.providerXLink = validatedX;

  // Step 7: Build anchors
  const anchors = {};
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

  // Step 9: Assemble and write packet
  const packet = {
    validated_overrides: validatedOverrides,
    anchors,
    member_candidates: memberCandidates,
    api_funding: apiFunding,
  };

  writeFileSync(output, JSON.stringify(packet, null, 2));
  process.stderr.write(`[rootdata] Packet written to ${output}\n`);
}

main().catch((err) => {
  process.stderr.write(`[rootdata] Fatal: ${err.message}\n`);
  process.exit(1);
});
