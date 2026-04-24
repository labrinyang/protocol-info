#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTranslatableFields } from '../translate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _pass = 0, _fail = 0;
function assert(condition, msg) {
  if (condition) _pass++;
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b),
    `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
process.on('exit', () => {
  console.log(`  ${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exitCode = 1;
});

// ── Tests ──

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'morpho-en.json'), 'utf8'));
const result = extractTranslatableFields(fixture);

// Should contain only translatable keys
assertEq(Object.keys(result).sort(), ['description', 'fundingRounds', 'memberOneLiners', 'memberPositions', 'tags'],
  'Extracted keys');

// description
assertEq(typeof result.description, 'string', 'description is string');
assert(result.description.includes('Morpho'), 'description contains protocol name');

// tags
assertEq(result.tags, ['lending', 'defi', 'yield-optimization'], 'tags match');

// memberPositions
assertEq(result.memberPositions, ['Co-founder & CEO', 'Co-founder & CTO'], 'positions match');

// memberOneLiners — second member has null
assertEq(result.memberOneLiners[0], 'Telecom Paris graduate who conceived Morpho during his studies', 'oneLiner[0]');
assertEq(result.memberOneLiners[1], null, 'oneLiner[1] is null');

// fundingRounds
assertEq(result.fundingRounds, ['Series A', 'Seed'], 'funding rounds match');

// Should NOT contain non-translatable fields
assert(result.slug === undefined, 'no slug');
assert(result.members === undefined, 'no full members array');
assert(result.providerWebsite === undefined, 'no providerWebsite');
assert(result.audits === undefined, 'no audits');

// ── Edge case: empty arrays ──
const empty = extractTranslatableFields({
  description: null,
  tags: [],
  members: [],
  fundingRounds: [],
});
assertEq(empty.description, null, 'null description preserved');
assertEq(empty.tags, [], 'empty tags');
assertEq(empty.memberPositions, [], 'empty memberPositions');
assertEq(empty.memberOneLiners, [], 'empty memberOneLiners');
assertEq(empty.fundingRounds, [], 'empty fundingRounds');
