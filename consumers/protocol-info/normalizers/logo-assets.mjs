// consumers/protocol-info/normalizers/logo-assets.mjs
//
// Rehost protocol, member, and audit logos into out/<logo-folder>/ and rewrite
// JSON fields to the CDN paths that mirror those folders.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { cdnLogoUrl, parseCdnLogoPath } from '../../../framework/logo-assets.mjs';

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
  if (UNAVATAR_RE.test(parsed.hostname)) return 'unavatar_unstable';
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

export async function rehostLogoAsset({
  sourceUrl,
  outputRoot,
  folder,
  nameBase,
  fetchImage = globalThis.fetch,
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
  const preexisting = existingAsset(outputRoot, folder, nameBase, extHint);
  if (preexisting) return { ...preexisting, reused: true };

  let response;
  try {
    response = await fetchImage(sourceUrl);
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

  if (existsSync(filePath)) return { url: cdnLogoUrl(folder, filename), relPath, reused: true };

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
      const key = normalizeKey(item?.auditor);
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

function preferCachedLogo(current, cached, outputRoot) {
  if (!cached) return current;
  if (!current) return cached;
  if (!outputRoot) return current;
  const currentRel = parseCdnLogoPath(current);
  if (currentRel && existsSync(join(outputRoot, currentRel))) return current;
  const cachedRel = parseCdnLogoPath(cached);
  if (cachedRel && existsSync(join(outputRoot, cachedRel))) return cached;
  return currentRel ? current : cached;
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
    const result = await rehostLogoAsset({
      sourceUrl: before,
      outputRoot,
      folder: LOGO_FOLDERS.member,
      nameBase: logoName([slug, member.memberName]),
      fetchImage,
    });
    trackCreated(result);
    member.avatarUrl = result.url;
    trackForCommit(result, before, member.avatarUrl ?? null);
    pushChange(changes, {
      field,
      entityKey,
      before,
      after: member.avatarUrl ?? null,
      reason: result.url ? 'member_logo_rehosted' : `member_logo_rejected:${result.reason}`,
      source: result.url ? 'framework:logo-assets' : 'framework:normalizer',
      confidence: result.url ? 0.9 : 1,
    });
    if (!result.url) {
      pushGap(gaps, {
        field,
        entityKey,
        reason: `Member logo URL could not be rehosted (${result.reason}); avatarUrl set to null.`,
        tried: ['members[].avatarUrl', 'rootdata.member_candidates[].avatar_url'],
      });
    }
  }

  for (let i = 0; i < (out.audits?.items || []).length; i++) {
    const item = out.audits.items[i];
    const before = item.auditorLogoUrl ?? null;
    const auditorKey = normalizeKey(item.auditor);
    const cached = auditorKey ? auditCache.get(auditorKey) : null;
    const source = preferCachedLogo(before, cached, outputRoot);
    if (!source) {
      item.auditorLogoUrl = null;
      continue;
    }
    const field = `audits.items[${i}].auditorLogoUrl`;
    const entityKey = `auditor:${item.auditor || ''}`;
    const result = await rehostLogoAsset({
      sourceUrl: source,
      outputRoot,
      folder: LOGO_FOLDERS.audit,
      nameBase: logoName([item.auditor || 'auditor']),
      fetchImage,
    });
    trackCreated(result);
    item.auditorLogoUrl = result.url;
    trackForCommit(result, before, item.auditorLogoUrl ?? null);
    pushChange(changes, {
      field,
      entityKey,
      before,
      after: item.auditorLogoUrl ?? null,
      reason: result.url ? 'audit_logo_rehosted' : `audit_logo_rejected:${result.reason}`,
      source: cached && source === cached ? 'out:audit-logo-cache' : 'framework:logo-assets',
      confidence: result.url ? 0.88 : 1,
    });
    if (!result.url) {
      pushGap(gaps, {
        field,
        entityKey,
        reason: `Audit logo URL could not be rehosted (${result.reason}); auditorLogoUrl set to null.`,
        tried: ['audits.items[].auditorLogoUrl', 'existing out/*/record.json audit logo cache'],
      });
    }
  }

  out = reorderProviderLogo(out);
  return { record: out, changes, gaps };
}
