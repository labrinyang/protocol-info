// Merges N subtask outputs into a single record + failure log.
// α-shape: handles slices only. β-shape (findings/gaps accumulation +
// audit-first R2 guard) extends this in phases 5–6.

export function mergeSlices(subtaskResults, opts = {}) {
  const onCollision = opts.onCollision || ((field, by, prev) => {
    console.error(`[merger] collision on field "${field}": "${by}" overwrites "${prev}"`);
  });

  const record = {};
  const failed_subtasks = [];
  const field_owner = {};   // field name → subtask name (for collision warnings)

  for (const r of subtaskResults) {
    if (!r.ok) {
      failed_subtasks.push({ name: r.name, reason: r.error || 'unknown' });
      continue;
    }
    if (!r.slice || typeof r.slice !== 'object') continue;
    for (const [k, v] of Object.entries(r.slice)) {
      if (k in record) onCollision(k, r.name, field_owner[k]);
      record[k] = v;
      field_owner[k] = r.name;
    }
  }

  return { record, failed_subtasks, field_owner };
}
