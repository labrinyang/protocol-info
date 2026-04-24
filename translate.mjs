#!/usr/bin/env node
//
// translate.mjs — Translate an English protocol-info JSON into multiple locales
// using parallel `claude -p --model haiku` processes.
//
// Usage:
//   node translate.mjs <slug.json> [--concurrency N] [--locales l1,l2,...] [--dry-run]
//
// Output:
//   Writes <slug>.<locale>.json files alongside the input file.
//   Adds locale:"en" to the source file.
//   Writes <slug>.translate-summary.tsv with per-locale results.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Constants ──

export const TARGET_LOCALES = [
  'en-us', 'zh-cn', 'zh-tw', 'zh-hk', 'ja-jp', 'ko-kr',
  'fr-fr', 'de', 'es', 'it-it', 'pt-br', 'pt', 'ru', 'uk-ua',
  'ar', 'hi-in', 'bn', 'vi', 'th-th', 'id',
];

export const LOCALE_NAMES = {
  'en':    'English',
  'en-us': 'American English',
  'zh-cn': 'Simplified Chinese (简体中文)',
  'zh-tw': 'Traditional Chinese (繁體中文)',
  'zh-hk': 'Traditional Chinese, Hong Kong (繁體中文·香港)',
  'ja-jp': 'Japanese (日本語)',
  'ko-kr': 'Korean (한국어)',
  'fr-fr': 'French (Français)',
  'de':    'German (Deutsch)',
  'es':    'Spanish (Español)',
  'it-it': 'Italian (Italiano)',
  'pt-br': 'Brazilian Portuguese (Português do Brasil)',
  'pt':    'European Portuguese (Português)',
  'ru':    'Russian (Русский)',
  'uk-ua': 'Ukrainian (Українська)',
  'ar':    'Arabic (العربية)',
  'hi-in': 'Hindi (हिन्दी)',
  'bn':    'Bengali (বাংলা)',
  'vi':    'Vietnamese (Tiếng Việt)',
  'th-th': 'Thai (ภาษาไทย)',
  'id':    'Indonesian (Bahasa Indonesia)',
};

// ── Pure functions (exported for testing) ──

export function extractTranslatableFields(data) {
  return {
    description: data.description ?? null,
    tags: data.tags || [],
    memberPositions: (data.members || []).map(m => m.memberPosition ?? ''),
    memberOneLiners: (data.members || []).map(m => m.oneLiner ?? null),
    fundingRounds: (data.fundingRounds || []).map(fr => fr.round ?? ''),
  };
}

export function mergeTranslation(sourceData, translated, locale) {
  const result = JSON.parse(JSON.stringify(sourceData));
  result.locale = locale;

  if (translated.description !== undefined) {
    result.description = translated.description;
  }
  if (Array.isArray(translated.tags) && translated.tags.length > 0) {
    result.tags = translated.tags;
  }
  if (Array.isArray(translated.memberPositions) && Array.isArray(result.members)) {
    result.members = result.members.map((m, i) => ({
      ...m,
      memberPosition: translated.memberPositions[i] ?? m.memberPosition,
      oneLiner: Array.isArray(translated.memberOneLiners)
        ? (translated.memberOneLiners[i] !== undefined ? translated.memberOneLiners[i] : m.oneLiner)
        : m.oneLiner,
    }));
  }
  if (Array.isArray(translated.fundingRounds) && Array.isArray(result.fundingRounds)) {
    result.fundingRounds = result.fundingRounds.map((fr, i) => ({
      ...fr,
      round: translated.fundingRounds[i] ?? fr.round,
    }));
  }

  delete result.sources;
  return result;
}

export function buildSystemPrompt(locale, localeName) {
  const tmplPath = join(__dirname, 'prompts', 'translate-system.md');
  const tmpl = readFileSync(tmplPath, 'utf8');
  return tmpl
    .replaceAll('{{TARGET_LOCALE}}', locale)
    .replaceAll('{{LOCALE_NAME}}', localeName);
}

// ── Concurrency pool ──

export async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ── Extract JSON from Claude response (inline, mirrors extract-json.mjs logic) ──

function extractJson(text) {
  let s = text;
  // Strip wrapping code fences only (leading ```json and trailing ```)
  const fenceMatch = s.match(/^[\s]*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```[\s]*$/);
  if (fenceMatch) s = fenceMatch[1];
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

// ── Spawn claude -p for a single locale ──

export function translateLocale(translatableJson, locale, claudeBin) {
  const localeName = LOCALE_NAMES[locale] || locale;
  const systemPrompt = buildSystemPrompt(locale, localeName);
  const userPrompt = JSON.stringify(translatableJson);

  return new Promise((resolve, reject) => {
    const args = [
      '-p', '-',
      '--output-format', 'json',
      '--model', 'haiku',
      '--max-turns', '1',
      '--max-budget-usd', '0.10',
      '--permission-mode', 'bypassPermissions',
      '--system-prompt', systemPrompt,
    ];

    const proc = spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('error', err => {
      reject(new Error(`Failed to spawn claude for locale ${locale}: ${err.message}`));
    });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code} for locale ${locale}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        let parsed;

        if (envelope.structured_output && typeof envelope.structured_output === 'object') {
          parsed = envelope.structured_output;
        } else if (typeof envelope.structured_output === 'string') {
          parsed = JSON.parse(envelope.structured_output);
        } else if (typeof envelope.result === 'string') {
          parsed = extractJson(envelope.result);
          if (!parsed) {
            reject(new Error(`Could not extract JSON from .result for locale ${locale}`));
            return;
          }
        } else {
          reject(new Error(`No usable output in envelope for locale ${locale}`));
          return;
        }

        resolve({
          translated: parsed,
          cost_usd: envelope.total_cost_usd ?? 0,
        });
      } catch (e) {
        reject(new Error(`JSON parse failed for locale ${locale}: ${e.message}`));
      }
    });

    proc.stdin.write(userPrompt);
    proc.stdin.end();
  });
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  let inputFile = null;
  let concurrency = 6;
  let localeFilter = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--concurrency':
        if (i + 1 >= args.length) { console.error('--concurrency requires a value'); process.exit(2); }
        concurrency = parseInt(args[++i], 10);
        break;
      case '--locales':
        if (i + 1 >= args.length) { console.error('--locales requires a value'); process.exit(2); }
        localeFilter = args[++i].split(',').map(s => s.trim());
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        if (!args[i].startsWith('-')) inputFile = args[i];
        else { console.error(`Unknown flag: ${args[i]}`); process.exit(2); }
    }
  }

  if (!inputFile) {
    console.error('Usage: node translate.mjs <slug.json> [--concurrency N] [--locales l1,l2] [--dry-run]');
    process.exit(2);
  }

  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const sourceData = JSON.parse(readFileSync(inputFile, 'utf8'));
  const translatable = extractTranslatableFields(sourceData);
  const outDir = dirname(inputFile);
  const slugBase = basename(inputFile, '.json');

  const locales = localeFilter
    ? TARGET_LOCALES.filter(l => localeFilter.includes(l))
    : TARGET_LOCALES;

  console.log(`Translating ${slugBase} into ${locales.length} locales (concurrency=${concurrency})`);

  if (dryRun) {
    for (const locale of locales) {
      const localeName = LOCALE_NAMES[locale] || locale;
      console.log(`\n--- ${locale} (${localeName}) ---`);
      console.log('System prompt:');
      console.log(buildSystemPrompt(locale, localeName));
      console.log('User prompt:');
      console.log(JSON.stringify(translatable, null, 2));
    }
    process.exit(0);
  }

  const tasks = locales.map(locale => () => translateLocale(translatable, locale, claudeBin));
  const startTime = Date.now();
  const results = await runPool(tasks, concurrency);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Write results
  const summaryLines = ['locale\tstatus\tcost_usd\tschema'];
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < locales.length; i++) {
    const locale = locales[i];
    const r = results[i];

    if (!r.ok) {
      failCount++;
      console.error(`  FAIL ${locale}: ${r.error.message}`);
      summaryLines.push(`${locale}\tFAIL\t0\t-`);
      continue;
    }

    const merged = mergeTranslation(sourceData, r.value.translated, locale);
    const outPath = join(outDir, `${slugBase}.${locale}.json`);
    writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');

    let schemaStatus = 'pass';
    try {
      execFileSync('node', [join(__dirname, 'validate.mjs'), outPath], { stdio: 'pipe' });
    } catch {
      schemaStatus = 'fail';
    }

    okCount++;
    const cost = r.value.cost_usd?.toFixed(4) ?? '0';
    summaryLines.push(`${locale}\tOK\t${cost}\t${schemaStatus}`);
    console.log(`  OK   ${locale} (${schemaStatus}) $${cost}`);
  }

  // Add locale:"en" to source file (only if at least one translation succeeded)
  if (okCount > 0) {
    sourceData.locale = 'en';
    writeFileSync(inputFile, JSON.stringify(sourceData, null, 2) + '\n');
    console.log(`  SET  locale:"en" on source file`);
  }

  // Write summary to .logs/ subdirectory
  const logDir = join(outDir, '.logs');
  mkdirSync(logDir, { recursive: true });
  const summaryPath = join(logDir, `${slugBase}.translate-summary.tsv`);
  writeFileSync(summaryPath, summaryLines.join('\n') + '\n');

  console.log(`\nDone: ${okCount} ok, ${failCount} failed (${elapsed}s)`);
  process.exit(failCount > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
