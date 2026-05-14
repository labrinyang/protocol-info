// Generic i18n stage. Consumer's manifest.i18n.translatable_fields drives
// which subset of the record gets translated. Per-locale provider calls write
// out sidecar JSON files of just the translated subset.
//
// Path syntax in translatable_fields:
//   - "description"               → top-level field
//   - "members[].memberPosition"  → field under each array element

import { runClaude } from './claude-wrapper.mjs';
import { runOpenAIChatCompletion } from './openai-wrapper.mjs';
import { assertProviderAllowed, resolveOpenAIPricing, resolveOpenAIModel } from './llm-router.mjs';
import { runWithLimit } from './parallel-runner.mjs';
import { validate } from './schema-validator.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function extractTranslatable(record, paths) {
  const out = {};
  for (const path of paths) {
    extractPath(record, parseFieldPath(path), out);
  }
  return out;
}

export function mergeTranslated(base, translated) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(translated || {})) {
    out[k] = mergeValue(out[k], v);
  }
  return out;
}

export function preserveSourceNullLiterals(source, translated) {
  if (isNullLiteral(source)) return source;
  if (Array.isArray(source)) {
    const translatedArray = Array.isArray(translated) ? translated : [];
    return source.map((item, index) => preserveSourceNullLiterals(item, translatedArray[index]));
  }
  if (source && typeof source === 'object') {
    const out = translated && typeof translated === 'object' && !Array.isArray(translated)
      ? { ...translated }
      : {};
    for (const [key, value] of Object.entries(source)) {
      out[key] = preserveSourceNullLiterals(value, out[key]);
    }
    return out;
  }
  return translated;
}

export function stripNullSourceLiterals(source) {
  if (isNullLiteral(source)) return undefined;
  if (Array.isArray(source)) {
    return source.map((item) => {
      const stripped = stripNullSourceLiterals(item);
      return stripped === undefined ? {} : stripped;
    });
  }
  if (source && typeof source === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(source)) {
      const stripped = stripNullSourceLiterals(value);
      if (stripped !== undefined) out[key] = stripped;
    }
    return out;
  }
  return source;
}

export function validateI18nOutput(output, schema) {
  const errors = validate(output, schema, '$');
  if (errors.length > 0) {
    throw new Error(`i18n output schema validation failed: ${errors.slice(0, 5).join('; ')}`);
  }
}

export function assertTranslatedArrayShape(source, translated, path = '$') {
  if (Array.isArray(source)) {
    if (!Array.isArray(translated)) {
      throw new Error(`${path}: expected translated array, got ${translated === null ? 'null' : typeof translated}`);
    }
    if (translated.length !== source.length) {
      throw new Error(`${path}: translated array length ${translated.length} must equal source length ${source.length}`);
    }
    for (let i = 0; i < source.length; i += 1) {
      assertTranslatedArrayShape(source[i], translated[i], `${path}[${i}]`);
    }
    return;
  }
  if (source && typeof source === 'object') {
    const translatedObject = translated && typeof translated === 'object' && !Array.isArray(translated)
      ? translated
      : {};
    for (const [key, value] of Object.entries(source)) {
      if (Array.isArray(value) || (value && typeof value === 'object')) {
        assertTranslatedArrayShape(value, translatedObject[key], `${path}.${key}`);
      }
    }
  }
}

function isNullLiteral(value) {
  return value === null || (typeof value === 'string' && value.trim().toLowerCase() === 'null');
}

function parseFieldPath(path) {
  return String(path).split('.').flatMap((part) => {
    if (part.endsWith('[]')) return [part.slice(0, -2), '[]'];
    return [part];
  }).filter(Boolean);
}

function extractPath(source, segments, target) {
  if (segments.length === 0) return true;
  const [segment, ...rest] = segments;

  if (segment === '[]') {
    if (!Array.isArray(source) || !Array.isArray(target)) return false;
    source.forEach((item, index) => {
      if (!target[index]) target[index] = {};
      extractPath(item, rest, target[index]);
    });
    return true;
  }

  if (!source || typeof source !== 'object' || !(segment in source)) return false;
  if (rest.length === 0) {
    target[segment] = source[segment];
    return true;
  }

  if (rest[0] === '[]') {
    if (!Array.isArray(source[segment])) return false;
    if (!Array.isArray(target[segment])) target[segment] = source[segment].map(() => ({}));
    return extractPath(source[segment], rest, target[segment]);
  }

  if (!target[segment] || typeof target[segment] !== 'object' || Array.isArray(target[segment])) {
    target[segment] = {};
  }
  const extracted = extractPath(source[segment], rest, target[segment]);
  if (!extracted && Object.keys(target[segment]).length === 0) delete target[segment];
  return extracted;
}

function mergeValue(baseValue, translatedValue) {
  if (Array.isArray(translatedValue) && Array.isArray(baseValue)) {
    return baseValue.map((item, index) => (
      index in translatedValue ? mergeValue(item, translatedValue[index]) : item
    ));
  }
  if (
    translatedValue &&
    typeof translatedValue === 'object' &&
    !Array.isArray(translatedValue) &&
    baseValue &&
    typeof baseValue === 'object' &&
    !Array.isArray(baseValue)
  ) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(translatedValue)) {
      merged[key] = mergeValue(baseValue[key], value);
    }
    return merged;
  }
  return translatedValue;
}

function markI18nOutputError(err) {
  err.kind = 'i18n_output';
  return err;
}

function normalizeI18nOutput(sourceJson, out, schema) {
  try {
    assertTranslatedArrayShape(sourceJson, out);
    const normalizedOut = preserveSourceNullLiterals(sourceJson, out);
    validateI18nOutput(normalizedOut, schema);
    return normalizedOut;
  } catch (err) {
    throw markI18nOutputError(err);
  }
}

function retryPromptSuffix(sourceJson) {
  const memberCount = Array.isArray(sourceJson?.members) ? sourceJson.members.length : null;
  return [
    '',
    'Correction required:',
    '- Return one valid JSON object matching the schema exactly.',
    '- Preserve every array length and order from Source JSON.',
    memberCount == null ? null : `- The members array MUST contain exactly ${memberCount} entries.`,
    '- Respect hard caps: description <= 1000 chars, members[].memberPosition <= 80 chars, members[].oneLiner <= 140 chars.',
    '- Compress naturally when needed; do not truncate mid-word and do not pad text.',
    '- Do not invent text for missing/null source fields.',
  ].filter(Boolean).join('\n');
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
  turnsCap = null,
  budgetCap = null,
  logger = console,
  provider = process.env.I18N_PROVIDER || 'claude',
  env = process.env,
  runOpenAI = runOpenAIChatCompletion,
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
  const promptSourceJson = stripNullSourceLiterals(sourceJson);
  const normalizedProvider = String(provider || 'claude').toLowerCase();
  assertProviderAllowed({ stage: 'i18n', provider: normalizedProvider, manifest });
  const openAIPricing = normalizedProvider === 'openai'
    ? resolveOpenAIPricing({ stage: 'i18n', env, manifest })
    : null;
  if (normalizedProvider === 'openai' && (budgetCap != null || budgetLedger) && !openAIPricing) {
    throw Object.assign(new Error('OpenAI-compatible i18n provider cannot honor USD budget caps without pricing configuration'), {
      kind: 'budget_unknown',
    });
  }

  const localeNameByCode = Object.fromEntries(
    (manifest.i18n.locale_catalog || []).map(e => [e.code, e.name_en])
  );

  async function runTranslation({ userPrompt, localeBudget }) {
    if (normalizedProvider === 'openai') {
      const openAIModelOverride = modelOverride && !/^claude[-_]/i.test(String(modelOverride))
        ? modelOverride
        : null;
      return runOpenAI({
        systemPrompt: sysPrompt,
        userPrompt,
        schemaJson: i18nSchema,
        model: resolveOpenAIModel({
          stage: 'i18n',
          model: openAIModelOverride,
          env,
          fallback: manifest.i18n.openai_model_default || 'gpt-5.5',
        }),
        baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: env.OPENAI_API_KEY,
        pricing: openAIPricing,
        maxBudgetUsd: budgetCap != null ? localeBudget : null,
        budgetLedger,
      });
    }
    if (normalizedProvider !== 'claude') {
      throw new Error(`unsupported I18N_PROVIDER "${provider}"`);
    }
    const baseTurns = 3;
    return runClaude({
      claudeBin,
      systemPrompt: sysPrompt,
      userPrompt,
      schemaJson: i18nSchema,
      maxTurns: turnsCap != null ? Math.min(baseTurns, turnsCap) : baseTurns,
      maxBudgetUsd: localeBudget,
      model: modelOverride || manifest.i18n.model_default,
      budgetLedger,
    });
  }

  const tasks = selectedLocales.map(code => async () => {
    const localeName = localeNameByCode[code] || code;
    const userPrompt = userTmpl
      .replaceAll('{{LOCALE_CODE}}', code)
      .replaceAll('{{LOCALE_NAME}}', localeName)
      .replaceAll('{{SOURCE_JSON}}', JSON.stringify(promptSourceJson, null, 2));

    const baseBudget = manifest.i18n.max_budget_usd_per_call ?? 0.10;
    const localeBudget = budgetCap != null && selectedLocales.length > 0
      ? Math.min(baseBudget, budgetCap / selectedLocales.length)
      : baseBudget;
    try {
      let env;
      let normalizedOut;
      let lastOutputError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        env = await runTranslation({
          userPrompt: attempt === 0 ? userPrompt : `${userPrompt}${retryPromptSuffix(sourceJson)}`,
          localeBudget,
        });
        let out = null;
        try {
          out = env.structured_output && typeof env.structured_output === 'object'
            ? env.structured_output
            : (typeof env.structured_output === 'string' ? JSON.parse(env.structured_output) : null);
          if (!out) throw new Error('no structured_output');
        } catch (err) {
          const outputError = markI18nOutputError(new Error(`invalid structured_output: ${err.message}`));
          lastOutputError = outputError;
          if (attempt === 0) {
            logger?.warn?.(`[i18n:${code}] retrying invalid translation output: ${String(outputError.message).replace(/[\r\n]+/g, ' ')}`);
            continue;
          }
          throw outputError;
        }
        try {
          normalizedOut = normalizeI18nOutput(sourceJson, out, i18nSchema);
          lastOutputError = null;
          break;
        } catch (err) {
          lastOutputError = err;
          if (attempt === 0) {
            logger?.warn?.(`[i18n:${code}] retrying invalid translation output: ${String(err.message || err).replace(/[\r\n]+/g, ' ')}`);
            continue;
          }
          throw err;
        }
      }
      if (lastOutputError) throw lastOutputError;
      await writeFile(join(outputDir, `${code}.json`), JSON.stringify(normalizedOut, null, 2));
      await writeFile(join(outputDir, `${code}.envelope.json`), JSON.stringify(env, null, 2));
      return {
        code,
        ok: true,
        translation: normalizedOut,
        cost_usd: Object.hasOwn(env, 'total_cost_usd') ? env.total_cost_usd : 0,
      };
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
