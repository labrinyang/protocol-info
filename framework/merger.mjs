// Merges N subtask outputs into a single record + failure log + accumulated
// findings/gaps/handoff_notes (each tagged with {stage, subtask}).
// α-shape (slice only) is preserved when r.findings/r.gaps are absent.
// β-shape (slice + findings + gaps + handoff_notes) is fully accumulated.
// Phase 6 will extend this with mergeR2 + audit-first guard.

export function mergeSlices(subtaskResults, opts = {}) {
  const stage = opts.stage || 'r1';
  const onCollision = opts.onCollision || ((field, by, prev) => {
    console.error(`[merger] collision on field "${field}": "${by}" overwrites "${prev}"`);
  });

  const record = {};
  const failed_subtasks = [];
  const findings = [];
  const gaps = [];
  const handoff_notes = [];
  const field_owner = {};

  for (const r of subtaskResults) {
    if (!r.ok) {
      failed_subtasks.push({ name: r.name, reason: r.error || 'unknown' });
      gaps.push({
        field: `<subtask:${r.name}>`,
        reason: `subtask_failed: ${r.error || 'unknown'}`,
        tried: [],
        stage, subtask: r.name,
      });
      continue;
    }
    if (r.slice && typeof r.slice === 'object') {
      for (const [k, v] of Object.entries(r.slice)) {
        if (k in record) onCollision(k, r.name, field_owner[k]);
        record[k] = v;
        field_owner[k] = r.name;
      }
    }
    if (Array.isArray(r.findings)) {
      for (const f of r.findings) findings.push({ ...f, stage, subtask: r.name });
    }
    if (Array.isArray(r.gaps)) {
      for (const g of r.gaps) gaps.push({ ...g, stage, subtask: r.name });
    }
    if (Array.isArray(r.handoff_notes)) {
      for (const h of r.handoff_notes) handoff_notes.push({ ...h, stage, subtask: r.name });
    }
  }

  return { record, findings, gaps, handoff_notes, failed_subtasks, field_owner };
}
