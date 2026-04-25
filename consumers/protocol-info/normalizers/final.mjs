// consumers/protocol-info/normalizers/final.mjs
// Deterministic metadata only. No factual web-claim overrides — those are R2's job.

export default function normalize({ record, now = new Date() }) {
  const out = JSON.parse(JSON.stringify(record));
  const changes = [];
  const today = now.toISOString().slice(0, 10);

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

  return { record: out, changes, gaps: [] };
}
