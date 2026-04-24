#!/usr/bin/env node
import { buildSystemPrompt, extractTranslatableFields, LOCALE_NAMES } from '../translate.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _pass = 0, _fail = 0;
function assert(condition, msg) {
  if (condition) _pass++;
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
process.on('exit', () => {
  console.log(`  ${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exitCode = 1;
});

// ── System prompt contains locale info ──
const prompt = buildSystemPrompt('zh-cn', 'Simplified Chinese (简体中文)');
assert(prompt.includes('zh-cn'), 'prompt contains locale code');
assert(prompt.includes('Simplified Chinese'), 'prompt contains locale name');
assert(prompt.includes('简体中文'), 'prompt contains native script name');
assert(prompt.includes('JSON'), 'prompt mentions JSON output');
assert(prompt.includes('null'), 'prompt mentions null handling');

// ── Different locales produce different prompts ──
const promptJa = buildSystemPrompt('ja-jp', 'Japanese (日本語)');
assert(promptJa.includes('ja-jp'), 'ja prompt has ja-jp');
assert(promptJa.includes('日本語'), 'ja prompt has native script name');
assert(promptJa.includes('## Target locale: ja-jp'), 'ja prompt target locale line is ja-jp, not zh-cn');

// ── User prompt (translatable fields) is valid JSON ──
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'morpho-en.json'), 'utf8'));
const translatable = extractTranslatableFields(fixture);
const userPrompt = JSON.stringify(translatable);

let parsed;
try {
  parsed = JSON.parse(userPrompt);
  assert(true, 'user prompt is valid JSON');
} catch (e) {
  assert(false, `user prompt is not valid JSON: ${e.message}`);
}

assert(parsed.description !== undefined, 'user prompt has description');
assert(Array.isArray(parsed.tags), 'user prompt has tags array');
assert(parsed.slug === undefined, 'user prompt does not include slug');
assert(parsed.providerWebsite === undefined, 'user prompt does not include URLs');

// ── All locale names are defined ──
const localesWithNames = ['zh-cn', 'zh-tw', 'zh-hk', 'ja-jp', 'ko-kr', 'fr-fr', 'de', 'es',
  'it-it', 'pt-br', 'pt', 'ru', 'uk-ua', 'ar', 'hi-in', 'bn', 'vi', 'th-th', 'id', 'en-us'];
for (const l of localesWithNames) {
  assert(LOCALE_NAMES[l] !== undefined, `LOCALE_NAMES has entry for ${l}`);
}
