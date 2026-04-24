#!/usr/bin/env node
//
// Integration test: calls real `claude -p --model haiku` for a single locale.
// Only runs when INTEGRATION=1 env var is set. Costs ~$0.01.
//
// Usage:
//   INTEGRATION=1 node test/test-integration-translate.mjs

import { readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTranslatableFields, translateLocale, mergeTranslation } from '../translate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATE = join(__dirname, '..', 'validate.mjs');

if (process.env.INTEGRATION !== '1') {
  console.log('  SKIP (set INTEGRATION=1 to run real claude -p haiku test)');
  process.exit(0);
}

let _pass = 0, _fail = 0;
function assert(condition, msg) {
  if (condition) _pass++;
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
process.on('exit', () => {
  console.log(`  ${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exitCode = 1;
});

const claudeBin = process.env.CLAUDE_BIN || 'claude';
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'morpho-en.json'), 'utf8'));
const translatable = extractTranslatableFields(fixture);

console.log('  Calling claude -p --model haiku for zh-cn translation...');

try {
  const result = await translateLocale(translatable, 'zh-cn', claudeBin);
  const t = result.translated;

  assert(t !== null && typeof t === 'object', 'got translated object');
  assert(typeof t.description === 'string', 'description is string');
  assert(t.description.length > 0, 'description is non-empty');
  assert(/[一-鿿]/.test(t.description), 'description contains Chinese characters');

  assert(Array.isArray(t.tags), 'tags is array');
  assert(t.tags.length > 0, 'tags is non-empty');

  assert(Array.isArray(t.memberPositions), 'memberPositions is array');
  assert(t.memberPositions.length >= 1, 'at least 1 memberPosition');

  assert(Array.isArray(t.fundingRounds), 'fundingRounds is array');
  assert(t.fundingRounds.length >= 1, 'at least 1 fundingRound');

  // Merge and validate
  const merged = mergeTranslation(fixture, t, 'zh-cn');
  const tmpPath = join(__dirname, 'fixtures', '_tmp_integration.json');
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2));

  try {
    execFileSync('node', [VALIDATE, tmpPath], { stdio: 'pipe' });
    assert(true, 'merged zh-cn passes schema validation');
  } catch (e) {
    const stdout = e.stdout?.toString() || '';
    assert(false, `schema validation failed: ${stdout}`);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }

  console.log(`  Cost: $${result.cost_usd}`);
} catch (e) {
  assert(false, `translateLocale threw: ${e.message}`);
}
