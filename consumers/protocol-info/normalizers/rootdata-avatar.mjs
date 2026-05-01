// consumers/protocol-info/normalizers/rootdata-avatar.mjs
//
// members[].avatarUrl is normalized before the logo-assets normalizer downloads
// and rewrites it to the OneKey static-logo CDN.
//
// The team R1 subtask emits null. This normalizer fills avatarUrl
// deterministically, post-R2:
//   1. preserve already-rehosted OneKey member avatar CDN paths;
//   2. use RootData project member_candidates by exact name;
//   3. search RootData people directly by memberName when project candidates
//      miss a verified member (for example Pendle's TN Lee);
//   4. fall back to paid Unavatar source URLs from verified member social links
//      or public handle-like pseudonyms.
//
// The Unavatar URL is never a final database value: logo-assets downloads it
// into out/protocol-member-logo/ and rewrites avatarUrl to the OneKey CDN.
//
import { parseCdnLogoPath } from '../../../framework/logo-assets.mjs';
import { search as defaultSearchRootData } from '../fetchers/rootdata.mjs';

const PBS_TWIMG_RE = /(?:^|\.)pbs\.twimg\.com$/i;
const UNAVATAR_BASE = 'https://unavatar.io';
const X_HOST_RE = /(?:^|\.)twitter\.com$|(?:^|\.)x\.com$/i;
const LINKEDIN_HOST_RE = /(?:^|\.)linkedin\.com$/i;
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_RESERVED_PATHS = new Set([
  'about',
  'account',
  'download',
  'explore',
  'hashtag',
  'home',
  'i',
  'intent',
  'messages',
  'notifications',
  'privacy',
  'search',
  'settings',
  'share',
  'tos',
]);

// Lowercase + strip diacritics + collapse whitespace + drop punctuation,
// so "TN Lee", "tn lee", "TN  Lee." all collide.
function normalizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns the reason to reject a URL, or null if it passes.
function rejectReason(url) {
  if (typeof url !== 'string' || url.trim() === '') return 'empty';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid_url';
  }
  if (parsed.protocol !== 'https:') return 'non_https';
  // pbs.twimg.com URLs are X's signed/short-lived asset links — they break
  // within hours/days and the embedded query params expire. RootData
  // sometimes returns these directly.
  if (PBS_TWIMG_RE.test(parsed.hostname)) return 'twimg_unstable';
  return null;
}

function indexCandidates(candidates) {
  const byName = new Map();
  for (const c of candidates || []) {
    const key = normalizeName(c?.name || c?.item_name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, c);
  }
  return byName;
}

function ownMemberCdnUrl(url) {
  const rel = parseCdnLogoPath(url);
  return !!rel && rel.startsWith('protocol-member-logo/');
}

function firstPathSegment(parsed) {
  const segment = parsed.pathname.split('/').filter(Boolean)[0] || '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function xHandleFromValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('@') && X_HANDLE_RE.test(trimmed.slice(1))) {
    return trimmed.slice(1);
  }
  if (/^[A-Za-z0-9_]{1,15}$/.test(trimmed)) return trimmed;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!X_HOST_RE.test(parsed.hostname)) return null;
  const segment = firstPathSegment(parsed).replace(/^@/, '');
  if (!segment || X_RESERVED_PATHS.has(segment.toLowerCase())) return null;
  return X_HANDLE_RE.test(segment) ? segment : null;
}

function linkedinUserFromUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (!LINKEDIN_HOST_RE.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (segments[0]?.toLowerCase() !== 'in') return null;
  const slug = segments[1]?.trim();
  if (!slug) return null;
  return slug.replace(/[^A-Za-z0-9._-]/g, '');
}

function handleLikeMemberName(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const trimmed = raw.replace(/^@/, '');
  if (!trimmed || trimmed.includes(' ')) return null;
  if (!raw.startsWith('@') && !/^0x/i.test(trimmed) && !/[0-9_]/.test(trimmed)) return null;
  return X_HANDLE_RE.test(trimmed) ? trimmed : null;
}

function withFallbackFalse(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('fallback', 'false');
  return parsed.toString();
}

function shouldPreserveExistingAvatarSource(url) {
  return !!url && !rejectReason(url);
}

export function unavatarSourcesForMember(member) {
  const sources = [];
  const links = member?.memberLink || {};
  const xHandle = xHandleFromValue(links.xLink);
  if (xHandle) {
    sources.push({
      url: withFallbackFalse(`${UNAVATAR_BASE}/x/${encodeURIComponent(xHandle)}`),
      source: 'unavatar:x',
      reason: 'unavatar_x_avatar_fallback',
      tried: ['members[].memberLink.xLink', `https://unavatar.io/x/${xHandle}`],
    });
  }

  const linkedinUser = linkedinUserFromUrl(links.linkedinLink);
  if (linkedinUser) {
    sources.push({
      url: withFallbackFalse(`${UNAVATAR_BASE}/linkedin/user:${encodeURIComponent(linkedinUser)}`),
      source: 'unavatar:linkedin',
      reason: 'unavatar_linkedin_avatar_fallback',
      tried: ['members[].memberLink.linkedinLink', `https://unavatar.io/linkedin/user:${linkedinUser}`],
    });
  }

  const nameHandle = handleLikeMemberName(member?.memberName);
  if (nameHandle) {
    sources.push({
      url: withFallbackFalse(`${UNAVATAR_BASE}/${encodeURIComponent(nameHandle)}`),
      source: 'unavatar:handle',
      reason: 'unavatar_handle_avatar_fallback',
      tried: ['members[].memberName', `https://unavatar.io/${nameHandle}`],
    });
  }

  return sources;
}

export function unavatarSourceForMember(member) {
  return unavatarSourcesForMember(member)[0] || null;
}

function rootDataUrlFromCandidate(candidate) {
  const url = candidate?.avatar_url || candidate?.logo;
  const rejected = rejectReason(url);
  if (rejected) return { url: null, rejected };
  return { url };
}

function rootDataSourceFromCandidate(candidate, source) {
  if (!candidate) return null;
  const { url, rejected } = rootDataUrlFromCandidate(candidate);
  if (!url) {
    return {
      url: null,
      reason: `${source}_avatar_rejected:${rejected}`,
      tried: [`${source}.${candidate.name || candidate.item_name || 'candidate'}.avatar_url`],
    };
  }
  return {
    url,
    source,
    reason: `${source}_avatar_applied`,
    tried: [`${source}.${candidate.name || candidate.item_name || 'candidate'}.avatar_url`],
  };
}

function protocolAliases(record) {
  return [...new Set([
    record?.displayName,
    record?.provider,
    record?.slug,
  ].map(normalizeName).filter(Boolean))];
}

function candidateMentionsProtocol(candidate, aliases) {
  if (aliases.length === 0) return true;
  const haystack = normalizeName([
    candidate?.introduce,
    candidate?.description,
    candidate?.bio,
    candidate?.title,
  ].filter(Boolean).join(' '));
  if (!haystack) return false;
  return aliases.some((alias) => haystack.includes(alias));
}

async function searchRootDataPersonSource({
  member,
  record,
  env,
  searchRootData,
  logger,
}) {
  const memberName = member?.memberName;
  if (!memberName || typeof searchRootData !== 'function') return null;
  if (!env?.ROOTDATA_API_KEY) return null;

  let packet;
  try {
    packet = await searchRootData({ query: memberName, type: 'person', limit: 5, env, logger });
  } catch (err) {
    logger?.warn?.(`rootdata person avatar search failed for ${memberName}: ${err.message}`);
    return null;
  }
  if (!packet?.ok) return null;

  const memberKey = normalizeName(memberName);
  const aliases = protocolAliases(record);
  for (const candidate of packet.results || []) {
    const candidateKey = normalizeName(candidate?.name || candidate?.item_name);
    if (!candidateKey || candidateKey !== memberKey) continue;
    if (!candidateMentionsProtocol(candidate, aliases)) continue;
    const source = rootDataSourceFromCandidate(candidate, 'rootdata.people_search');
    if (source?.url) return source;
  }
  return null;
}

export default async function normalize({
  record,
  evidence,
  env = {},
  searchRootData = defaultSearchRootData,
  logger = null,
}) {
  const out = JSON.parse(JSON.stringify(record));
  const changes = [];
  const gaps = [];

  if (!Array.isArray(out?.members) || out.members.length === 0) {
    return { record: out, changes, gaps };
  }

  const rootdataOk = evidence?.fetcher_status?.rootdata === 'ok';
  const byName = indexCandidates(evidence?.rootdata?.member_candidates);

  for (let i = 0; i < out.members.length; i++) {
    const member = out.members[i];
    const before = member.avatarUrl ?? null;
    const field = `members[${i}].avatarUrl`;
    const entityKey = `member:${member.memberName || ''}`;

    if (ownMemberCdnUrl(before)) {
      continue;
    }
    if (shouldPreserveExistingAvatarSource(before)) {
      continue;
    }

    let selected = null;
    const projectCandidate = rootdataOk ? byName.get(normalizeName(member.memberName)) : null;
    const projectSource = rootDataSourceFromCandidate(projectCandidate, 'rootdata.member_candidates');
    if (projectSource?.url) {
      selected = projectSource;
    }
    if (!selected) {
      selected = await searchRootDataPersonSource({ member, record: out, env, searchRootData, logger });
    }
    if (!selected) {
      selected = unavatarSourceForMember(member);
    }

    const after = selected?.url || (before && !rejectReason(before) ? before : null);
    const reason = selected?.reason || (after ? 'existing_avatar_source_preserved' : 'avatar_source_missing');
    const sourceLabel = selected?.source || (after ? 'record:avatarUrl' : null);

    if (!after) {
      gaps.push({
        field,
        entity_key: entityKey,
        reason: 'No usable RootData avatar and no verified X/LinkedIn profile or handle-like pseudonym was available for paid Unavatar lookup; avatar set to null.',
        tried: [...new Set([
          'rootdata.member_candidates by exact name',
          'rootdata.ser_inv person search by memberName',
          'members[].memberLink.xLink',
          'members[].memberLink.linkedinLink',
          'members[].memberName',
        ])],
      });
    }

    if (before !== after) {
      member.avatarUrl = after;
      changes.push({
        field,
        entity_key: entityKey,
        before,
        after,
        reason: reason || 'avatar_normalized',
        source: sourceLabel || 'framework:normalizer',
        confidence: after ? 0.9 : 1,
      });
    }
  }

  return { record: out, changes, gaps };
}
