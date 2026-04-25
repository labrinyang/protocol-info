// Merges N subtask outputs into a single record + failure log + accumulated
// findings/gaps/handoff_notes (each tagged with {stage, subtask}).
// α-shape (slice only) is preserved when r.findings/r.gaps are absent.
// β-shape (slice + findings + gaps + handoff_notes) is fully accumulated.
// Also exports mergeR2 (Phase 6 R2 reconcile) with an audit-first guard
// that protects high-confidence R1 fields from uncited R2 overwrites.

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

// Merges R2 output back into R1 with the audit-first guard.
// Audit-first rule:
//   - R2 may change fields freely when it emits a matching changes[] or finding.
//   - If R2 changes a high-confidence R1 field without any matching change/finding,
//     keep R1 and add a suppression gap.
//   - If R2 changes a lower-confidence/unfound field without provenance, accept it
//     but add an uncited_r2_change gap for review.
//
// Field-level granularity: walks both records' top-level keys, then recurses
// into objects. Arrays are replaced wholesale, but item-level descendant paths
// or shared entity_key values count as explanations for the array change.

const HIGH_CONF = 0.85;

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pathMatches(entryPath, changedPath) {
  if (!entryPath) return false;
  return entryPath === changedPath ||
    entryPath.startsWith(`${changedPath}.`) ||
    entryPath.startsWith(`${changedPath}[`);
}

function entityKeysFor(value) {
  const keys = new Set();
  const add = v => { if (v) keys.add(v); };
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    add(item.entity_key);
    if (item.memberLink?.xLink) add(`member:x:${item.memberLink.xLink}`);
    if (item.memberLink?.linkedinLink) add(`member:linkedin:${item.memberLink.linkedinLink}`);
    if (item.memberName) add(`member:name:${String(item.memberName).toLowerCase()}`);
    if (item.round && item.date) add(`funding:${item.round}:${item.date}`);
    if (item.auditor && item.reportUrl) add(`audit:${item.auditor}:${item.reportUrl}`);
  };
  if (Array.isArray(value)) value.forEach(visit);
  else visit(value);
  return keys;
}

function evidenceFor(entries, fieldPath, entityKeys = new Set()) {
  if (!Array.isArray(entries)) return null;
  return entries.find(e =>
    pathMatches(e.field, fieldPath) ||
    (e.entity_key && entityKeys.has(e.entity_key))
  ) || null;
}

function mergeRecursive(r1Val, r2Val, path, r1Findings, r2Findings, r2Changes, gaps) {
  if (r2Val === undefined) return r1Val;
  if (r1Val === undefined) {
    // R2 added this key. For leaves, audit; for objects, recurse with an empty R1 side.
    const isObj = r2Val && typeof r2Val === 'object' && !Array.isArray(r2Val);
    if (isObj) {
      return mergeRecursive({}, r2Val, path, r1Findings, r2Findings, r2Changes, gaps);
    }
    // Leaf addition: audit
    const entityKeys = entityKeysFor(r2Val);
    const r2f = evidenceFor(r2Findings, path, entityKeys);
    const r2c = evidenceFor(r2Changes, path, entityKeys);
    if (!r2f && !r2c) {
      gaps.push({
        field: path,
        reason: 'r2_added_field_uncited',
        tried: [],
        stage: 'r2',
        subtask: 'reconcile',
      });
    }
    return r2Val;
  }

  if (r1Val && r2Val && typeof r1Val === 'object' && typeof r2Val === 'object'
      && !Array.isArray(r1Val) && !Array.isArray(r2Val)) {
    const out = { ...r1Val };
    for (const k of new Set([...Object.keys(r1Val), ...Object.keys(r2Val)])) {
      out[k] = mergeRecursive(r1Val[k], r2Val[k], path ? `${path}.${k}` : k, r1Findings, r2Findings, r2Changes, gaps);
    }
    return out;
  }

  if (sameJson(r1Val, r2Val)) return r2Val;
  const entityKeys = new Set([...entityKeysFor(r1Val), ...entityKeysFor(r2Val)]);
  const r1f = evidenceFor(r1Findings, path, entityKeys);
  const r2f = evidenceFor(r2Findings, path, entityKeys);
  const r2c = evidenceFor(r2Changes, path, entityKeys);
  const explained = !!(r2f || r2c);
  if (!explained && r1f && r1f.confidence > HIGH_CONF) {
    gaps.push({
      field: path,
      reason: `r2_uncited_high_conf_change_suppressed: r1.confidence=${r1f.confidence}`,
      tried: [],
      stage: 'r2',
      subtask: 'reconcile',
    });
    return r1Val;
  }
  if (!explained) {
    gaps.push({
      field: path,
      reason: 'uncited_r2_change',
      tried: [],
      stage: 'r2',
      subtask: 'reconcile',
    });
  }
  return r2Val;
}

export function mergeR2(r1, r2) {
  const auditGaps = [];
  const merged_record = mergeRecursive(
    r1.record, r2.record, '',
    r1.findings, r2.findings, r2.changes || [],
    auditGaps
  );

  const r2ByField = new Map((r2.findings || []).map(f => [f.field, f]));
  const r1ByField = new Map((r1.findings || []).map(f => [f.field, f]));
  const findings = [
    // Keep R1 findings whose R2 counterpart (if any) has lower confidence
    ...(r1.findings || []).filter(f => {
      const rf = r2ByField.get(f.field);
      return !rf || (rf.confidence ?? 0) < (f.confidence ?? 0);
    }),
    // Keep R2 findings whose R1 counterpart (if any) has lower-or-equal confidence (R2 ties win)
    ...(r2.findings || [])
      .filter(rf => {
        const f = r1ByField.get(rf.field);
        return !f || (rf.confidence ?? 0) >= (f.confidence ?? 0);
      })
      .map(f => ({ ...f, stage: 'r2', subtask: 'reconcile' })),
  ];

  const r2GapFields = new Set((r2.gaps || []).map(g => g.field));
  const r2FindingFields = new Set((r2.findings || []).map(f => f.field));
  const gaps = [
    ...(r1.gaps || []).filter(g => !r2GapFields.has(g.field) && !r2FindingFields.has(g.field)),
    ...((r2.gaps || []).map(g => ({ ...g, stage: 'r2', subtask: 'reconcile' }))),
    ...auditGaps,
  ];

  const changes = [
    ...((r1.changes || []).map(c => c)),
    ...((r2.changes || []).map(c => ({ ...c, stage: 'r2', subtask: 'reconcile' }))),
  ];

  return { record: merged_record, findings, changes, gaps };
}
