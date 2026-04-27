// framework/cli/i18n.mjs — bash-callable i18n stage.
// Usage:
//   node framework/cli/i18n.mjs --manifest M --record R --locales LIST --output-dir D [--parallel N] [--model M]
// `--max-budget`, when present, is the i18n stage total and is split across locales.

import { readFile } from 'node:fs/promises';
import { loadManifest } from '../manifest-loader.mjs';
import { runI18nStage } from '../i18n-stage.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const recordPath = arg('record');
const localesArg = arg('locales', '');
const outputDir = arg('output-dir');
const parallelism = parseInt(arg('parallel', '8'), 10);
const modelOverride = arg('model', null);
const maxTurnsCap = arg('max-turns', null);
const maxBudgetCap = arg('max-budget', null);
const turnsCap = maxTurnsCap ? Math.max(1, parseInt(maxTurnsCap, 10)) : null;
const budgetCap = maxBudgetCap ? Math.max(0, Number(maxBudgetCap)) : null;

if (!manifestPath || !recordPath || !outputDir) {
  console.error('usage: i18n.mjs --manifest M --record R --locales <comma-list> --output-dir D');
  process.exit(2);
}

const manifest = await loadManifest(manifestPath);
const record = JSON.parse(await readFile(recordPath, 'utf8'));

// Pre-validate locale codes against manifest catalog; warn + drop unknowns
const knownCodes = new Set((manifest.i18n?.locale_catalog || []).map(e => e.code));
const requested = localesArg.split(',').map(s => s.trim()).filter(Boolean);
const selectedLocales = [];
for (const code of requested) {
  if (knownCodes.size === 0 || knownCodes.has(code)) {
    selectedLocales.push(code);
  } else {
    console.error(`[i18n] unknown locale '${code}' (not in manifest.i18n.locale_catalog) — skipping`);
  }
}

const result = await runI18nStage({
  manifest, record, selectedLocales, outputDir, parallelism, modelOverride,
  turnsCap, budgetCap,
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  logger: { info: m => console.error(`[i18n] ${m}`), warn: m => console.error(`[i18n:warn] ${m}`) },
});

console.error(`[i18n] ${result.ok}/${selectedLocales.length} ok; failed: ${result.failed.join(',') || 'none'}`);
process.exit(0);
