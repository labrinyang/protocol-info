// framework/normalizer-stage.mjs — runs each consumer normalizer in sequence.
// Each normalizer is a default export:
// normalize({record, evidence, manifest, now, ...context}) => {record, changes, gaps}.
// Stage threads record forward, appends each normalizer's changes/gaps (tagged stage='normalize').

import { pathToFileURL } from 'node:url';

export async function runNormalizers({
  normalizers,
  record,
  evidence,
  manifest,
  incomingChanges = [],
  incomingGaps = [],
  now = new Date(),
  ...context
}) {
  let cur = record;
  const changes = [...incomingChanges];
  let gaps = [...incomingGaps];

  for (const n of normalizers || []) {
    const mod = await import(pathToFileURL(n.module_abs).href);
    const fn = mod.default;
    if (typeof fn !== 'function') {
      console.error(`[normalize] ${n.name} has no default export — skipping`);
      continue;
    }
    const out = await fn({ record: cur, evidence, manifest, now, ...context });
    cur = out?.record ?? cur;
    const normalizedChanges = [];
    for (const c of (out?.changes ?? [])) {
      normalizedChanges.push(c);
      changes.push({ ...c, stage: 'normalize', normalizer: n.name });
    }
    gaps = removeResolvedGaps(gaps, normalizedChanges, cur);
    for (const g of (out?.gaps ?? [])) {
      gaps.push({ ...g, stage: 'normalize', normalizer: n.name });
    }
  }

  return { record: cur, changes, gaps };
}

function removeResolvedGaps(gaps, changes, record) {
  const resolvedFields = new Set(
    changes
      .filter((change) => change?.field && isResolvedValue(change.after))
      .map((change) => change.field),
  );
  if (resolvedFields.size === 0) return gaps;
  return gaps.filter((gap) => !gapResolved(gap?.field, resolvedFields, record));
}

function gapResolved(field, resolvedFields, record) {
  if (resolvedFields.has(field)) return true;
  if (typeof field !== 'string' || !/\[(?:\*|)\]/.test(field)) return false;
  const concrete = concretePathValues(record, field);
  if (concrete.length === 0) return false;
  if (!concrete.some((entry) => resolvedFields.has(entry.field))) return false;
  return concrete.every((entry) => isResolvedValue(entry.value));
}

function concretePathValues(root, pattern) {
  const parts = pattern.split('.');
  let states = [{ value: root, field: '' }];

  for (const part of parts) {
    const match = part.match(/^([A-Za-z_$][A-Za-z0-9_$-]*)(?:\[(\*|\d*)\])?$/);
    if (!match) return [];
    const [, key, rawIndex] = match;
    const next = [];
    for (const state of states) {
      const parent = state.value;
      if (!parent || typeof parent !== 'object' || !(key in parent)) continue;
      const value = parent[key];
      const prefix = state.field ? `${state.field}.${key}` : key;
      if (rawIndex === undefined) {
        next.push({ value, field: prefix });
      } else if (rawIndex === '*' || rawIndex === '') {
        if (!Array.isArray(value)) continue;
        value.forEach((item, index) => {
          next.push({ value: item, field: `${prefix}[${index}]` });
        });
      } else {
        const index = Number(rawIndex);
        if (!Array.isArray(value) || !Number.isInteger(index) || index < 0 || index >= value.length) continue;
        next.push({ value: value[index], field: `${prefix}[${index}]` });
      }
    }
    states = next;
    if (states.length === 0) return [];
  }

  return states;
}

function isResolvedValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
