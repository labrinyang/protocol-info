// Generic i18n stage. Consumer's manifest.i18n.translatable_fields drives
// which subset of the record gets translated. Per-locale Haiku call writes
// out a sidecar JSON of just the translated subset.
//
// Path syntax in translatable_fields:
//   - "description"               → top-level field
//   - "members[].memberPosition"  → field under each array element

import { runClaude } from './claude-wrapper.mjs';
import { runWithLimit } from './parallel-runner.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function extractTranslatable(record, paths) {
  const out = {};
  for (const path of paths) {
    if (path.includes('[]')) {
      const [arrayKey, ...rest] = path.split('[].');
      const subPath = rest.join('[].');
      const arr = record[arrayKey];
      if (!Array.isArray(arr)) continue;
      if (!Array.isArray(out[arrayKey])) out[arrayKey] = arr.map(() => ({}));
      arr.forEach((item, i) => {
        const v = item?.[subPath];
        if (v !== undefined) out[arrayKey][i][subPath] = v;
      });
    } else {
      if (record[path] !== undefined) out[path] = record[path];
    }
  }
  return out;
}

export function mergeTranslated(base, translated) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(translated)) {
    if (Array.isArray(v) && Array.isArray(out[k])) {
      v.forEach((tItem, i) => {
        if (out[k][i] && tItem && typeof tItem === 'object') {
          out[k][i] = { ...out[k][i], ...tItem };
        }
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function runI18nStage({
  manifest,
  record,
  selectedLocales,
  outputDir,
  parallelism = 8,
  claudeBin = 'claude',
  modelOverride = null,
  budgetLedger = null,
  logger = console,
}) {
  if (!manifest.i18n?.enabled) return { ok: 0, failed: [], translations: {} };
  if (selectedLocales.length === 0) return { ok: 0, failed: [], translations: {} };
  if (manifest._abs?.i18n == null) return { ok: 0, failed: [], translations: {} };

  await mkdir(outputDir, { recursive: true });

  // Truncate failures.log at run start so per-run triage isn't polluted by prior errors
  try { await writeFile(join(outputDir, 'failures.log'), ''); } catch { /* dir may not exist yet */ }

  const i18nCfg = manifest._abs.i18n;
  const sysPrompt = await readFile(i18nCfg.system_prompt_abs, 'utf8');
  const userTmpl = await readFile(i18nCfg.user_prompt_abs, 'utf8');
  const i18nSchema = JSON.parse(await readFile(i18nCfg.schema_abs, 'utf8'));
  const sourceJson = extractTranslatable(record, manifest.i18n.translatable_fields);

  const localeNameByCode = Object.fromEntries(
    (manifest.i18n.locale_catalog || []).map(e => [e.code, e.name_en])
  );

  const tasks = selectedLocales.map(code => async () => {
    const localeName = localeNameByCode[code] || code;
    const userPrompt = userTmpl
      .replaceAll('{{LOCALE_CODE}}', code)
      .replaceAll('{{LOCALE_NAME}}', localeName)
      .replaceAll('{{SOURCE_JSON}}', JSON.stringify(sourceJson, null, 2));

    try {
      const env = await runClaude({
        claudeBin,
        systemPrompt: sysPrompt,
        userPrompt,
        schemaJson: i18nSchema,
        maxTurns: 3,
        maxBudgetUsd: manifest.i18n.max_budget_usd_per_call ?? 0.10,
        model: modelOverride || manifest.i18n.model_default,
        budgetLedger,
      });
      const out = env.structured_output && typeof env.structured_output === 'object'
        ? env.structured_output
        : (typeof env.structured_output === 'string' ? JSON.parse(env.structured_output) : null);
      if (!out) throw new Error('no structured_output');
      await writeFile(join(outputDir, `${code}.json`), JSON.stringify(out, null, 2));
      await writeFile(join(outputDir, `${code}.envelope.json`), JSON.stringify(env, null, 2));
      return { code, ok: true, translation: out, cost_usd: env.total_cost_usd ?? 0 };
    } catch (err) {
      const fl = join(outputDir, 'failures.log');
      const sanitized = String(err.message || err).replace(/[\r\n]+/g, ' ');
      await writeFile(fl, `${code}\t${sanitized}\n`, { flag: 'a' });
      logger?.warn?.(`[i18n:${code}] ${sanitized}`);
      return { code, ok: false, error: sanitized };
    }
  });

  const results = await runWithLimit(parallelism, tasks);
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).map(r => r.code);
  const translations = Object.fromEntries(
    results.filter(r => r.ok).map(r => [r.code, r.translation])
  );
  return { ok, failed, translations };
}
