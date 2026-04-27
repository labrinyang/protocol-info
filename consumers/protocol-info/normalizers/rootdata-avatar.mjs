// consumers/protocol-info/normalizers/rootdata-avatar.mjs
//
// Phase A of the avatarUrl rework: members[].avatarUrl is sourced
// exclusively from RootData. The team R1 subtask emits null; this
// normalizer fills the field deterministically, post-R2, by name-matching
// each member against `evidence.rootdata.member_candidates[]` and copying
// the candidate's `avatar_url` (RootData's `logo` field).
//
// No LLM tokens, no extra HTTP calls, no third-party rate-limited gateway
// (unavatar.io's 25 req/day-per-IP anonymous limit makes runtime fetches
// from the dashboard frontend non-viable).
//
// Phase B (out of scope here, owned by backend ops): download these RootData
// URLs server-side and rehost them on owned object storage; rewrite
// `avatarUrl` to the in-house URL before the dashboard ever sees it.

const PBS_TWIMG_RE = /(?:^|\.)pbs\.twimg\.com$/i;

// Lowercase + strip diacritics + collapse whitespace + drop punctuation,
// so "Robert Leshner", "robert leshner", "Robert  Leshner." all collide.
function normalizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
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
    const key = normalizeName(c?.name);
    if (!key) continue;
    // First candidate wins (already sorted by score in the fetcher).
    if (!byName.has(key)) byName.set(key, c);
  }
  return byName;
}

export default function normalize({ record, evidence }) {
  const out = JSON.parse(JSON.stringify(record));
  const changes = [];
  const gaps = [];

  if (!Array.isArray(out?.members) || out.members.length === 0) {
    return { record: out, changes, gaps };
  }

  const fetcherStatus = evidence?.fetcher_status?.rootdata;
  const rootdataOk = fetcherStatus === 'ok';
  const candidates = evidence?.rootdata?.member_candidates;
  const byName = indexCandidates(candidates);

  for (let i = 0; i < out.members.length; i++) {
    const member = out.members[i];
    const before = member.avatarUrl ?? null;
    const field = `members[${i}].avatarUrl`;
    const entityKey = `member:${member.memberName || ''}`;

    let after = null;
    let reason;
    let sourceLabel;

    if (!rootdataOk) {
      // RootData unavailable for this run — leave the field null. We don't
      // append a per-member gap here: the run-level meta.json already records
      // the fetcher status, and 1-N gap entries per disabled run is noise.
      reason = 'rootdata_unavailable';
    } else {
      const cand = byName.get(normalizeName(member.memberName));
      if (!cand) {
        reason = 'rootdata_no_match';
        gaps.push({
          field,
          entity_key: entityKey,
          reason: 'No matching person in rootdata.member_candidates by name; avatar set to null.',
          tried: ['rootdata.ser_inv (people search by project name)'],
        });
      } else {
        const rejected = rejectReason(cand.avatar_url);
        if (rejected) {
          reason = `rootdata_logo_rejected:${rejected}`;
          gaps.push({
            field,
            entity_key: entityKey,
            reason: `RootData candidate matched but logo URL rejected (${rejected}); avatar set to null.`,
            tried: [`rootdata.member_candidates[${cand.name}].avatar_url`],
          });
        } else {
          after = cand.avatar_url;
          sourceLabel = 'rootdata.ser_inv';
        }
      }
    }

    if (before !== after) {
      member.avatarUrl = after;
      changes.push({
        field,
        entity_key: entityKey,
        before,
        after,
        reason: reason || 'rootdata_avatar_applied',
        source: sourceLabel || 'framework:normalizer',
        confidence: after ? 0.9 : 1,
      });
    }
  }

  return { record: out, changes, gaps };
}
