// framework/cli/evidence-diff.mjs — CLI shim around enrichEvidenceDiff.
// Reads --evidence-in and --record-in JSON files, calls enrichEvidenceDiff,
// writes the enriched packet (pretty-printed) to --evidence-out.

import { readFile, writeFile } from 'node:fs/promises';
import { enrichEvidenceDiff } from '../evidence-diff.mjs';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}

const evidenceIn = arg('evidence-in');
const recordIn = arg('record-in');
const evidenceOut = arg('evidence-out');

if (!evidenceIn || !recordIn || !evidenceOut) {
  console.error('usage: evidence-diff.mjs --evidence-in E --record-in R --evidence-out O');
  process.exit(2);
}

const evidence = JSON.parse(await readFile(evidenceIn, 'utf8'));
const record = JSON.parse(await readFile(recordIn, 'utf8'));
const enriched = enrichEvidenceDiff({ evidence, record });
await writeFile(evidenceOut, JSON.stringify(enriched, null, 2));
process.exit(0);
