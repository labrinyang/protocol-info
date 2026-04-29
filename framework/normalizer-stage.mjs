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
  const gaps = [...incomingGaps];

  for (const n of normalizers || []) {
    const mod = await import(pathToFileURL(n.module_abs).href);
    const fn = mod.default;
    if (typeof fn !== 'function') {
      console.error(`[normalize] ${n.name} has no default export — skipping`);
      continue;
    }
    const out = await fn({ record: cur, evidence, manifest, now, ...context });
    cur = out?.record ?? cur;
    for (const c of (out?.changes ?? [])) {
      changes.push({ ...c, stage: 'normalize', normalizer: n.name });
    }
    for (const g of (out?.gaps ?? [])) {
      gaps.push({ ...g, stage: 'normalize', normalizer: n.name });
    }
  }

  return { record: cur, changes, gaps };
}
