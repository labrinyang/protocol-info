// consumers/protocol-info/normalizers/logo-assets.mjs
//
// Rehost protocol, member, and audit logos into out/<logo-folder>/ and rewrite
// JSON fields to the CDN paths that mirror those folders.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { cdnLogoUrl, parseCdnLogoPath } from '../../../framework/logo-assets.mjs';
import { extractProviderLogoUrl, search as defaultSearchRootData } from '../fetchers/rootdata.mjs';
import { unavatarSourcesForMember } from './rootdata-avatar.mjs';

export const LOGO_FOLDERS = Object.freeze({
  member: 'protocol-member-logo',
  provider: 'protocol-logo',
  audit: 'audit-logo',
});

const PBS_TWIMG_RE = /(?:^|\.)pbs\.twimg\.com$/i;
const UNAVATAR_RE = /(?:^|\.)unavatar\.io$/i;
const VALID_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
const EXT_BY_CONTENT_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
const GITHUB_HOST_RE = /(?:^|\.)github\.com$/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const AUDITOR_ALIAS_KEYS = new Map([
  ['adevarlabs', 'adevar'],
  ['adevar-labs', 'adevar'],
  ['ackee', 'ackee'],
  ['ackee-blockchain', 'ackee'],
  ['abdk', 'abdk'],
  ['abdk-consulting', 'abdk'],
]);

function canonicalEntityKey(value) {
  return normalizeKey(value)
    .replace(/-(?:inc|incorporated|llc|ltd|limited|labs|lab|foundation|security|audit|audits|blockchain|consulting)$/g, '');
}

function canonicalAuditorKey(value) {
  const key = normalizeKey(value);
  return AUDITOR_ALIAS_KEYS.get(key) || canonicalEntityKey(value);
}

function withFallbackFalse(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('fallback', 'false');
  return parsed.toString();
}

export function logoName(parts) {
  const joined = parts.map(normalizeKey).filter(Boolean).join('-');
  return (joined || 'logo').slice(0, 96).replace(/-+$/g, '') || 'logo';
}

function rejectSourceUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return 'empty';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid_url';
  }
  if (parsed.protocol !== 'https:') return 'non_https';
  if (PBS_TWIMG_RE.test(parsed.hostname)) return 'twimg_unstable';
  return null;
}

function extensionFromUrl(url) {
  try {
    const ext = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (!ext || !VALID_EXTS.includes(ext)) return null;
    return ext === 'jpeg' ? 'jpg' : ext;
  } catch {
    return null;
  }
}

function extensionFromContentType(contentType) {
  if (!contentType) return null;
  const normalized = String(contentType).split(';')[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE[normalized] || null;
}

function existingAsset(outputRoot, folder, nameBase, preferredExt = null) {
  const exts = preferredExt ? [preferredExt] : VALID_EXTS.map((ext) => ext === 'jpeg' ? 'jpg' : ext);
  for (const ext of [...new Set(exts)]) {
    const filename = `${nameBase}.${ext}`;
    const relPath = `${folder}/${filename}`;
    if (existsSync(join(outputRoot, relPath))) {
      return { filename, relPath, url: cdnLogoUrl(folder, filename) };
    }
  }
  return null;
}

function cdnPathForFolder(url, folder) {
  const rel = parseCdnLogoPath(url);
  if (!rel) return null;
  if (!rel.startsWith(`${folder}/`)) return null;
  return rel;
}

function fetchOptionsForSource(sourceUrl, env = {}) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  if (!UNAVATAR_RE.test(parsed.hostname)) return undefined;
  const apiKey = typeof env?.UNAVATAR_API_KEY === 'string' ? env.UNAVATAR_API_KEY.trim() : '';
  if (!apiKey) return undefined;
  return { headers: { 'x-api-key': apiKey } };
}

export async function rehostLogoAsset({
  sourceUrl,
  outputRoot,
  folder,
  nameBase,
  fetchImage = globalThis.fetch,
  env = {},
  reuseExisting = true,
}) {
  if (!sourceUrl) return { url: null, reason: 'empty' };
  if (!outputRoot) return { url: sourceUrl, reason: 'output_root_missing' };

  const cdnRel = cdnPathForFolder(sourceUrl, folder);
  if (cdnRel) {
    if (existsSync(join(outputRoot, cdnRel))) {
      return { url: sourceUrl, relPath: cdnRel, reused: true };
    }
    // If a prior JSON record already points at our CDN but the local file is
    // missing, try to fetch that CDN URL into the matching local path.
    nameBase = basename(cdnRel).replace(/\.[^.]+$/, '') || nameBase;
  }

  const rejected = rejectSourceUrl(sourceUrl);
  if (rejected) return { url: null, reason: rejected };
  if (typeof fetchImage !== 'function') return { url: null, reason: 'fetch_unavailable' };

  const extHint = extensionFromUrl(sourceUrl);
  const preexisting = reuseExisting ? existingAsset(outputRoot, folder, nameBase, extHint) : null;
  if (preexisting) return { ...preexisting, reused: true };

  let response;
  try {
    const fetchOptions = fetchOptionsForSource(sourceUrl, env);
    response = fetchOptions ? await fetchImage(sourceUrl, fetchOptions) : await fetchImage(sourceUrl);
  } catch (err) {
    return { url: null, reason: `fetch_failed:${err.message}` };
  }
  if (!response?.ok) {
    return { url: null, reason: `http_${response?.status || 'error'}` };
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const ext = extHint || extensionFromContentType(contentType) || 'png';
  const filename = cdnRel ? basename(cdnRel) : `${nameBase}.${ext}`;
  const relPath = `${folder}/${filename}`;
  const filePath = join(outputRoot, relPath);

  if (reuseExisting && existsSync(filePath)) return { url: cdnLogoUrl(folder, filename), relPath, reused: true };

  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(join(outputRoot, folder), { recursive: true });
  await writeFile(filePath, bytes);
  return { url: cdnLogoUrl(folder, filename), relPath, created: true };
}

function sourceFromRootData(evidence) {
  const rootdata = evidence?.rootdata || {};
  const anchors = rootdata.anchors || {};
  const candidates = [
    rootdata.provider_logo_url,
    rootdata.project_logo_url,
    anchors.providerLogoUrl,
    anchors.provider_logo_url,
    anchors.logo,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (candidate && typeof candidate.value === 'string' && candidate.value.trim()) return candidate.value;
  }
  return null;
}

function rootDataResultNameCandidates(item) {
  return [
    item?.name,
    item?.item_name,
    item?.project_name,
    item?.display_name,
    item?.title,
  ].filter((value) => typeof value === 'string' && value.trim());
}

function collectStringValues(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectStringValues(nested, out);
  }
  return out;
}

function githubOwnerFromUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (!GITHUB_HOST_RE.test(parsed.hostname)) return null;
  const owner = parsed.pathname.split('/').filter(Boolean)[0] || '';
  if (!owner || owner.startsWith('.') || owner.includes('..')) return null;
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ? owner : null;
}

function githubOwnerFromRootDataItem(item) {
  const explicitValues = [
    item?.github,
    item?.github_url,
    item?.githubUrl,
    item?.github_link,
    item?.githubLink,
    item?.links?.github,
    item?.links?.github_url,
    item?.social?.github,
    item?.socials?.github,
    item?.social_links?.github,
  ];
  for (const value of explicitValues) {
    const owner = githubOwnerFromUrl(value);
    if (owner) return owner;
  }

  for (const value of collectStringValues(item)) {
    const owner = githubOwnerFromUrl(value);
    if (owner) return owner;
  }
  return null;
}

function isExactRootDataEntityMatch(query, item) {
  const queryKey = canonicalAuditorKey(query);
  if (!queryKey) return false;
  return rootDataResultNameCandidates(item).some((candidate) => canonicalAuditorKey(candidate) === queryKey);
}

async function sourceFromRootDataAudit({
  auditor,
  env,
  logger,
  searchRootData,
}) {
  if (!auditor || typeof searchRootData !== 'function') return { url: null, reason: 'rootdata_search_unavailable' };
  if (!env?.ROOTDATA_API_KEY) return { url: null, reason: 'rootdata_key_missing' };

  let packet;
  try {
    packet = await searchRootData({ query: auditor, type: 'project', limit: 5, env, logger });
  } catch (err) {
    logger?.warn?.(`rootdata audit logo search failed for ${auditor}: ${err.message}`);
    return { url: null, reason: `rootdata_search_failed:${err.message}` };
  }

  if (!packet?.ok) return { url: null, reason: packet?.error || 'rootdata_search_failed' };

  for (const item of packet.results || []) {
    if (!isExactRootDataEntityMatch(auditor, item)) continue;
    const url = extractProviderLogoUrl(item);
    if (url) return { url, reason: 'rootdata_exact_match' };
    const githubOwner = githubOwnerFromRootDataItem(item);
    if (githubOwner) {
      return {
        url: withFallbackFalse(`https://unavatar.io/github/${encodeURIComponent(githubOwner)}`),
        reason: 'rootdata_exact_match_github_unavatar',
      };
    }
  }

  return { url: null, reason: 'rootdata_no_exact_logo_match' };
}

function scoreCachedUrl(outputRoot, value) {
  const rel = parseCdnLogoPath(value);
  if (rel && existsSync(join(outputRoot, rel))) return 3;
  if (rel) return 2;
  if (!rejectSourceUrl(value)) return 1;
  return 0;
}

async function buildAuditLogoCache(outputRoot) {
  const cache = new Map();
  if (!outputRoot || !existsSync(outputRoot)) return cache;
  let entries = [];
  try {
    entries = await readdir(outputRoot, { withFileTypes: true });
  } catch {
    return cache;
  }
  const ignored = new Set(['.git', ...Object.values(LOGO_FOLDERS)]);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
    const recordPath = join(outputRoot, entry.name, 'record.json');
    if (!existsSync(recordPath)) continue;
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, 'utf8'));
    } catch {
      continue;
    }
    for (const item of record?.audits?.items || []) {
      const key = canonicalAuditorKey(item?.auditor);
      const url = item?.auditorLogoUrl;
      if (!key || !url) continue;
      const nextScore = scoreCachedUrl(outputRoot, url);
      if (nextScore === 0) continue;
      const cur = cache.get(key);
      if (!cur || nextScore > cur.score) cache.set(key, { url, score: nextScore });
    }
  }
  return new Map([...cache].map(([key, value]) => [key, value.url]));
}

function reorderProviderLogo(record) {
  const value = Object.hasOwn(record, 'providerLogoUrl') ? record.providerLogoUrl : null;
  const reordered = {};
  let inserted = false;
  for (const [key, val] of Object.entries(record)) {
    if (key === 'providerLogoUrl') continue;
    reordered[key] = val;
    if (key === 'provider') {
      reordered.providerLogoUrl = value;
      inserted = true;
    }
  }
  if (!inserted) reordered.providerLogoUrl = value;
  return reordered;
}

function pushChange(changes, { field, entityKey, before, after, reason, source, confidence = 0.9 }) {
  if (before === after) return;
  changes.push({
    field,
    ...(entityKey ? { entity_key: entityKey } : {}),
    before,
    after,
    reason,
    source,
    confidence,
  });
}

function pushGap(gaps, { field, entityKey, reason, tried }) {
  gaps.push({
    field,
    ...(entityKey ? { entity_key: entityKey } : {}),
    reason,
    tried,
  });
}

export default async function normalize({
  record,
  evidence,
  outputRoot,
  fetchImage = globalThis.fetch,
  searchRootData = defaultSearchRootData,
  env = {},
  logger = null,
  createdLogoAssetPaths = null,
  logoAssetPathsToCommit = null,
}) {
  let out = reorderProviderLogo(clone(record));
  const changes = [];
  const gaps = [];

  const slug = out.slug || out.provider || normalizeKey(out.displayName) || 'protocol';
  const auditCache = await buildAuditLogoCache(outputRoot);

  const trackCreated = (result) => {
    if (result?.created && result.relPath && Array.isArray(createdLogoAssetPaths)) {
      createdLogoAssetPaths.push(result.relPath);
    }
  };
  const trackForCommit = (result, before, after) => {
    if (!result?.relPath || !Array.isArray(logoAssetPathsToCommit)) return;
    if (result.created || before !== after) logoAssetPathsToCommit.push(result.relPath);
  };

  const providerBefore = out.providerLogoUrl ?? null;
  const providerSources = [...new Set([providerBefore, sourceFromRootData(evidence)].filter(Boolean))];
  if (providerSources.length > 0) {
    let result = null;
    for (const providerSource of providerSources) {
      result = await rehostLogoAsset({
        sourceUrl: providerSource,
        outputRoot,
        folder: LOGO_FOLDERS.provider,
        nameBase: logoName([slug]),
        fetchImage,
        env,
      });
      trackCreated(result);
      if (result.url) break;
    }
    out.providerLogoUrl = result.url;
    trackForCommit(result, providerBefore, out.providerLogoUrl ?? null);
    pushChange(changes, {
      field: 'providerLogoUrl',
      before: providerBefore,
      after: out.providerLogoUrl ?? null,
      reason: result.url ? 'provider_logo_rehosted' : `provider_logo_rejected:${result.reason}`,
      source: result.url ? 'framework:logo-assets' : 'framework:normalizer',
      confidence: result.url ? 0.9 : 1,
    });
    if (!result.url) {
      pushGap(gaps, {
        field: 'providerLogoUrl',
        reason: `Provider logo URL could not be rehosted (${result.reason}); providerLogoUrl set to null.`,
        tried: ['record.providerLogoUrl', 'rootdata.provider_logo_url'],
      });
    }
  } else {
    out.providerLogoUrl = null;
  }

  for (let i = 0; i < (out.members || []).length; i++) {
    const member = out.members[i];
    const before = member.avatarUrl ?? null;
    if (!before) continue;
    const field = `members[${i}].avatarUrl`;
    const entityKey = `member:${member.memberName || ''}`;
    let result = await rehostLogoAsset({
      sourceUrl: before,
      outputRoot,
      folder: LOGO_FOLDERS.member,
      nameBase: logoName([slug, member.memberName]),
      fetchImage,
      env,
    });
    const failedPrimaryReason = result.url ? null : result.reason;
    let fallbackSource = null;
    if (!result.url) {
      const tried = new Set([before]);
      for (const unavatarFallback of unavatarSourcesForMember(member)) {
        if (!unavatarFallback?.url || tried.has(unavatarFallback.url)) continue;
        tried.add(unavatarFallback.url);
        const fallbackResult = await rehostLogoAsset({
          sourceUrl: unavatarFallback.url,
          outputRoot,
          folder: LOGO_FOLDERS.member,
          nameBase: logoName([slug, member.memberName]),
          fetchImage,
          env,
        });
        if (fallbackResult.url) {
          result = fallbackResult;
          fallbackSource = unavatarFallback.source;
          break;
        }
      }
    }
    if (fallbackSource) {
      result = { ...result, fallbackSource, primaryReason: failedPrimaryReason };
    }
    trackCreated(result);
    member.avatarUrl = result.url;
    trackForCommit(result, before, member.avatarUrl ?? null);
    pushChange(changes, {
      field,
      entityKey,
      before,
      after: member.avatarUrl ?? null,
      reason: result.url
        ? result.fallbackSource
          ? `member_logo_rehosted_via_unavatar_fallback:${result.primaryReason}`
          : 'member_logo_rehosted'
        : `member_logo_rejected:${result.reason}`,
      source: result.url
        ? result.fallbackSource || 'framework:logo-assets'
        : 'framework:normalizer',
      confidence: result.url ? 0.9 : 1,
    });
    if (!result.url) {
      pushGap(gaps, {
        field,
        entityKey,
        reason: `Member logo URL could not be rehosted (${result.reason}); avatarUrl set to null.`,
        tried: ['members[].avatarUrl', 'unavatar paid avatar source', 'rootdata.member_candidates[].avatar_url'],
      });
    }
  }

  for (let i = 0; i < (out.audits?.items || []).length; i++) {
    const item = out.audits.items[i];
    const before = item.auditorLogoUrl ?? null;
    const auditorKey = canonicalAuditorKey(item.auditor);
    const field = `audits.items[${i}].auditorLogoUrl`;
    const entityKey = `auditor:${item.auditor || ''}`;
    const local = outputRoot && item.auditor
      ? existingAsset(outputRoot, LOGO_FOLDERS.audit, logoName([item.auditor || 'auditor']))
      : null;
    const cached = auditorKey ? auditCache.get(auditorKey) : null;
    const sourceCandidates = [];
    if (before) sourceCandidates.push({ url: before, source: 'record:auditorLogoUrl' });
    if (local?.url && local.url !== before) sourceCandidates.push({ url: local.url, source: 'out:audit-logo-local' });
    if (cached && cached !== before && cached !== local?.url) sourceCandidates.push({ url: cached, source: 'out:audit-logo-cache' });

    let rootDataSource = { url: null, reason: sourceCandidates.length ? 'deferred_until_local_sources_fail' : null };
    let result = null;
    let selectedSource = null;
    const failedReasons = [];

    for (const candidate of sourceCandidates) {
      const candidateResult = await rehostLogoAsset({
        sourceUrl: candidate.url,
        outputRoot,
        folder: LOGO_FOLDERS.audit,
        nameBase: logoName([item.auditor || 'auditor']),
        fetchImage,
        env,
        reuseExisting: !(candidate.source === 'record:auditorLogoUrl' && !cdnPathForFolder(candidate.url, LOGO_FOLDERS.audit)),
      });
      if (candidateResult.url) {
        result = candidateResult;
        selectedSource = candidate;
        break;
      }
      failedReasons.push(`${candidate.source}:${candidateResult.reason}`);
    }

    if (!result) {
      rootDataSource = await sourceFromRootDataAudit({ auditor: item.auditor, env, logger, searchRootData });
      if (rootDataSource.url) {
        const candidateResult = await rehostLogoAsset({
          sourceUrl: rootDataSource.url,
          outputRoot,
          folder: LOGO_FOLDERS.audit,
          nameBase: logoName([item.auditor || 'auditor']),
          fetchImage,
          env,
        });
        if (candidateResult.url) {
          result = candidateResult;
          selectedSource = { url: rootDataSource.url, source: 'rootdata:audit-logo' };
        } else {
          failedReasons.push(`rootdata:audit-logo:${candidateResult.reason}`);
        }
      }
    }

    if (!result) {
      item.auditorLogoUrl = null;
      if (before !== null) {
        pushChange(changes, {
          field,
          entityKey,
          before,
          after: null,
          reason: `audit_logo_missing:${rootDataSource.reason || failedReasons.join(',') || 'no_source'}`,
          source: 'framework:normalizer',
          confidence: 1,
        });
      }
      if (rootDataSource.reason && !['rootdata_key_missing', 'rootdata_search_unavailable'].includes(rootDataSource.reason)) {
        pushGap(gaps, {
          field,
          entityKey,
          reason: `Audit logo could not be resolved from local cache or RootData (${rootDataSource.reason}); auditorLogoUrl set to null.`,
          tried: ['local audit-logo asset', 'existing out/*/record.json audit logo cache', 'RootData project search'],
        });
      }
      continue;
    }
    trackCreated(result);
    item.auditorLogoUrl = result.url;
    trackForCommit(result, before, item.auditorLogoUrl ?? null);
    pushChange(changes, {
      field,
      entityKey,
      before,
      after: item.auditorLogoUrl ?? null,
      reason: result.url ? 'audit_logo_rehosted' : `audit_logo_rejected:${result.reason}`,
      source: selectedSource?.source || 'framework:logo-assets',
      confidence: result.url ? 0.88 : 1,
    });
    if (!result.url) {
      pushGap(gaps, {
        field,
        entityKey,
        reason: `Audit logo URL could not be rehosted (${result.reason}); auditorLogoUrl set to null.`,
        tried: ['local audit-logo asset', 'existing out/*/record.json audit logo cache', 'RootData project search', 'audits.items[].auditorLogoUrl'],
      });
    }
  }

  out = reorderProviderLogo(out);
  return { record: out, changes, gaps };
}
