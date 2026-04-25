// framework/cli/post.mjs — bash-callable post-processing executor.
// Reads record + per-locale translation sidecars (from <slug-dir>/_debug/i18n/),
// runs each manifest.post_processing module, and produces:
//   - record.import.json  (dashboard envelope, via dashboard-export module)
//   - record.full.json    (record + i18n map; only when translations exist)
// Also patches meta.json.i18n with locales_ok / locales_failed / cost_usd
// based on sidecars + envelopes.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const manifestPath = arg('manifest');
const slugDir = arg('slug-dir');

if (!manifestPath || !slugDir) {
  console.error('usage: post.mjs --manifest M --slug-dir D');
  process.exit(2);
}

const manifest = await loadManifest(manifestPath);
const out = manifest.output || {};
const recordFile = join(slugDir, out.record_filename || 'record.json');
const importFile = join(slugDir, out.import_filename || 'record.import.json');
const fullFile = join(slugDir, out.full_filename || 'record.full.json');
const metaFile = join(slugDir, out.meta_filename || 'meta.json');
const debugDir = join(slugDir, out.debug_dir || '_debug');
const i18nDir = join(debugDir, 'i18n');

const record = JSON.parse(await readFile(recordFile, 'utf8'));

// Collect translations from <i18nDir>/<locale>.json (skipping envelopes + failures.log)
const translations = {};
const okCodes = [];
const envFiles = [];
let i18nDirExists = true;
try {
  for (const f of await readdir(i18nDir)) {
    if (f === 'failures.log') continue;
    if (f.endsWith('.envelope.json')) {
      envFiles.push(join(i18nDir, f));
      continue;
    }
    if (!f.endsWith('.json')) continue;
    const code = basename(f, '.json');
    translations[code] = JSON.parse(await readFile(join(i18nDir, f), 'utf8'));
    okCodes.push(code);
  }
} catch {
  i18nDirExists = false;
}

// Read failure log to derive locales_failed
const failedCodes = [];
if (i18nDirExists) {
  try {
    const log = await readFile(join(i18nDir, 'failures.log'), 'utf8');
    for (const line of log.split('\n')) {
      const code = line.split('\t')[0];
      if (code && !failedCodes.includes(code)) failedCodes.push(code);
    }
  } catch { /* no failures.log */ }
}

// Aggregate i18n cost from envelopes
let i18nCost = 0;
for (const f of envFiles) {
  try {
    const env = JSON.parse(await readFile(f, 'utf8'));
    i18nCost += Number(env.total_cost_usd || 0);
  } catch { /* skip malformed */ }
}

// Run each post_processing module
for (const p of manifest._abs.post_processing || []) {
  const mod = await import(pathToFileURL(p.module_abs).href);
  if (typeof mod.buildImportFile === 'function' && p.name === 'dashboard-export') {
    const file = mod.buildImportFile({
      record,
      translations,
      sourceLocale: p.config?.source_locale_dashboard_code || 'en',
      stripFields: p.config?.strip_fields || ['sources'],
    });
    await writeFile(importFile, JSON.stringify(file, null, 2));
  } else if (typeof mod.default === 'function') {
    // Generic post module signature: default({record, translations, slugDir, manifest, config})
    await mod.default({ record, translations, slugDir, manifest, config: p.config });
  } else {
    console.error(`[post] ${p.name} has no recognized export — skipping`);
  }
}

// record.full.json (inline i18n map) — only when translations exist
if (Object.keys(translations).length > 0) {
  const full = { ...record, i18n: translations };
  await writeFile(fullFile, JSON.stringify(full, null, 2));
}

// Patch meta.json.i18n if any locale activity occurred
if (i18nDirExists && (okCodes.length > 0 || failedCodes.length > 0)) {
  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    const localesRequested = Array.from(new Set([...okCodes, ...failedCodes])).sort();
    meta.i18n = {
      model: manifest.i18n?.model_default ?? null,
      locales_requested: localesRequested,
      locales_ok: okCodes.sort(),
      locales_failed: failedCodes.sort(),
      cost_usd: i18nCost,
    };
    await writeFile(metaFile, JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error(`[post] meta.json patch failed: ${err.message}`);
  }
}

console.error('[post] done');
