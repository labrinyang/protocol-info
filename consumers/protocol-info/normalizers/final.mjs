// consumers/protocol-info/normalizers/final.mjs
// Deterministic metadata only. No factual web-claim overrides — those are R2's job.

export default function normalize({ record, now = new Date() }) {
  const out = JSON.parse(JSON.stringify(record));
  const changes = [];
  const gaps = [];
  const today = now.toISOString().slice(0, 10);

  for (let i = 0; i < (out.members || []).length; i++) {
    const member = out.members[i];
    const before = member.oneLiner;
    if (typeof before !== 'string') continue;
    if (!isPlaceholderOneLiner(before)) continue;
    member.oneLiner = null;
    changes.push({
      field: `members[${i}].oneLiner`,
      entity_key: `member:${member.memberName || ''}`,
      before,
      after: null,
      reason: 'placeholder_one_liner_removed',
      source: 'framework:normalizer',
      confidence: 1,
    });
    gaps.push({
      field: `members[${i}].oneLiner`,
      entity_key: `member:${member.memberName || ''}`,
      reason: 'No verifiable member background was found; placeholder oneLiner was removed and set to null.',
      tried: ['members[].oneLiner placeholder guard'],
    });
  }

  if (out.audits && Array.isArray(out.audits.items)) {
    const before = out.audits.lastScannedAt;
    if (before !== today) {
      out.audits.lastScannedAt = today;
      changes.push({
        field: 'audits.lastScannedAt',
        before: before ?? null,
        after: today,
        reason: 'crawler scan date',
        source: 'framework:normalizer',
        confidence: 1,
      });
    }
  }

  return { record: out, changes, gaps };
}

function isPlaceholderOneLiner(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  const compact = lower.replace(/[\s._-]+/g, ' ').replace(/[。.!]+$/g, '').trim();
  const exactPlaceholders = new Set([
    'tbd',
    'tba',
    'n/a',
    'na',
    'none',
    'unknown',
    'unverified',
    'not available',
    'not provided',
    'no information',
    'no public information',
  ]);
  if (exactPlaceholders.has(compact)) return true;
  if (/[占位]|暂未|暂无|待(?:补充|完善|添加|更新)|未(?:提供|找到|公开|披露)/.test(text)) return true;
  if (/\bplaceholder\b/i.test(text)) return true;
  if (/\bunverified\b/i.test(text)) return true;
  if (/^(?:no|not enough)\s+(?:verifiable|public|available)?\s*(?:information|info|data|sources?)/i.test(compact)) return true;
  if (/^to be (?:added|filled|provided|updated)/i.test(compact)) return true;
  if (/^add .* later$/i.test(compact)) return true;
  return false;
}
