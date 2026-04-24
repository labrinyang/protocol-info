#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTranslation } from '../translate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATE = join(__dirname, '..', 'validate.mjs');

let _pass = 0, _fail = 0;
function assert(condition, msg) {
  if (condition) _pass++;
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
process.on('exit', () => {
  console.log(`  ${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exitCode = 1;
});

const source = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'morpho-en.json'), 'utf8'));

const translated = {
  description: 'Morphoは分散型レンディングプロトコルです。',
  tags: ['レンディング', 'DeFi', '利回り最適化'],
  memberPositions: ['共同創設者兼CEO', '共同創設者兼CTO'],
  memberOneLiners: ['Telecom Paris卒業生、在学中にMorphoを構想', null],
  fundingRounds: ['シリーズA', 'シード'],
};

const merged = mergeTranslation(source, translated, 'ja-jp');

// Write to temp file and validate against schema
const tmpPath = join(__dirname, 'fixtures', '_tmp_validate.json');
writeFileSync(tmpPath, JSON.stringify(merged, null, 2));

try {
  execFileSync('node', [VALIDATE, tmpPath], { stdio: 'pipe' });
  assert(true, 'merged ja-jp passes schema validation');
} catch (e) {
  const stderr = e.stderr?.toString() || '';
  const stdout = e.stdout?.toString() || '';
  assert(false, `schema validation failed: ${stdout} ${stderr}`);
} finally {
  try { unlinkSync(tmpPath); } catch {}
}

// Also validate en source with locale added
const enWithLocale = { ...source, locale: 'en' };
const tmpPathEn = join(__dirname, 'fixtures', '_tmp_validate_en.json');
writeFileSync(tmpPathEn, JSON.stringify(enWithLocale, null, 2));

try {
  execFileSync('node', [VALIDATE, tmpPathEn], { stdio: 'pipe' });
  assert(true, 'source with locale:"en" passes schema validation');
} catch (e) {
  const stdout = e.stdout?.toString() || '';
  assert(false, `en source with locale failed validation: ${stdout}`);
} finally {
  try { unlinkSync(tmpPathEn); } catch {}
}
