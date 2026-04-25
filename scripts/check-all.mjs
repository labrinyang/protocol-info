#!/usr/bin/env node
// Composite pre-push check: bash syntax + tests + (later) slice coherence.
// Each step prints its own header. Exits non-zero on first failure.

import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'bash -n run.sh', cmd: 'bash', args: ['-n', 'run.sh'] },
  { name: 'tests/run.mjs', cmd: 'node', args: ['tests/run.mjs'] },
  // slice-coherence appended in phase 4
];

let ok = true;
for (const s of steps) {
  console.log(`\n── ${s.name} ──`);
  const r = spawnSync(s.cmd, s.args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ ${s.name} failed (exit ${r.status})`);
    ok = false;
    break;
  }
  console.log(`✓ ${s.name}`);
}
process.exit(ok ? 0 : 1);
