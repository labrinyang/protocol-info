import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';
import { preflightWritableSlug, rollbackSlugAndCleanup, commitAndRebuild } from '../slug-transaction.mjs';
import { loadRecordEnvelope, writeRecordEnvelope } from '../record-state.mjs';
import { validateRecord } from '../schema-validator.mjs';
import { createWriteCommandContext, writeValidationFailure } from '../command-write-context.mjs';
import { normalizeI18nLocaleCode } from '../i18n-locales.mjs';
import { SUMMARY_HEADER } from '../summary-schema.mjs';
import { listTranslationSidecars, seedSidecarsFromFull } from '../i18n-cache.mjs';
import { extractTranslatable, mergeTranslated, assertTranslatedArrayShape } from '../i18n-stage.mjs';
import { sourceHashesFor, localeHashesMatch, readSourceHashMeta, writeLocaleSourceHashes } from '../i18n-hashes.mjs';
import { runWithLimit } from '../parallel-runner.mjs';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = dirname(COMMAND_DIR);
function freshRunId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function selectedLocales(localesArg, manifest) {
  const catalog = (manifest.i18n?.locale_catalog || []).map((e) => e.code).filter(Boolean);
  const known = new Set(catalog);
  let raw;
  if (!localesArg || localesArg === 'all') raw = catalog;
  else if (localesArg === 'none') raw = [];
  else raw = localesArg.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  const unknown = [];
  for (const rawCode of raw) {
    const code = normalizeI18nLocaleCode(rawCode, manifest);
    if (known.size > 0 && !known.has(code)) {
      unknown.push(rawCode);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return { locales: out, unknown };
}

function i18nDirFor(slugDir, manifest) {
  const out = manifest.output || {};
  return join(slugDir, out.debug_dir || '_debug', 'i18n');
}

async function removeLocaleSidecars(i18nDir, locales) {
  for (const code of locales) {
    await rm(join(i18nDir, `${code}.json`), { force: true });
    await rm(join(i18nDir, `${code}.envelope.json`), { force: true });
  }
}

function incrementalLocales(locales, existing, force) {
  if (force) return locales;
  return locales.filter((code) => !existing.has(code));
}

function i18nMessage(slug, requestedLocales, localesToRun, force, fields = []) {
  const fieldSuffix = fields.length > 0 ? ` fields ${fields.join(',')}` : '';
  if (force) return `i18n(${slug}): refresh ${localesToRun.join(', ')}${fieldSuffix}`;
  if (localesToRun.length === requestedLocales.length) return `i18n(${slug}): ${localesToRun.join(', ')}${fieldSuffix}`;
  if (localesToRun.length === 0) return `i18n(${slug}): refresh exports`;
  return `i18n(${slug}): add ${localesToRun.join(', ')}${fieldSuffix}`;
}

async function summaryI18nColumn(slugDir, manifest) {
  const out = manifest.output || {};
  try {
    const meta = JSON.parse(await readFile(join(slugDir, out.meta_filename || 'meta.json'), 'utf8'));
    const i18n = meta?.i18n || {};
    const ok = Array.isArray(i18n.locales_ok) ? i18n.locales_ok.length : 0;
    const requested = Array.isArray(i18n.locales_requested)
      ? i18n.locales_requested.length
      : ok + (Array.isArray(i18n.locales_failed) ? i18n.locales_failed.length : 0);
    if (requested > 0) return `${ok}/${requested}`;
  } catch {
    // Fall back to the number of successful sidecars below.
  }
  const sidecars = await listTranslationSidecars(slugDir, { manifest });
  return sidecars.size > 0 ? `${sidecars.size}/${sidecars.size}` : '-';
}

async function updateSlugSummaryI18n(slugDir, slug, i18nCol, validation = { ok: true }) {
  const summaryPath = join(slugDir, 'summary.tsv');
  let baseCols = [slug, 'OK', '-', '-', '-', 'pass', '-', '-'];
  try {
    const content = await readFile(summaryPath, 'utf8');
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length >= 2) {
      const headers = lines[0].split('\t');
      const row = lines.slice(1)
        .map((line) => line.split('\t'))
        .find((cols) => cols[headers.indexOf('slug')] === slug)
        || lines[1].split('\t');
      const value = (name, fallback) => {
        const idx = headers.indexOf(name);
        return idx >= 0 && row[idx] ? row[idx] : fallback;
      };
      baseCols = [
        value('slug', slug),
        validation.ok ? 'OK' : 'SCHEMA_FAIL',
        value('members', '-'),
        value('funding', '-'),
        value('audits', '-'),
        validation.ok ? 'pass' : 'fail',
        value('source', '-'),
        value('api_status', '-'),
      ];
    }
  } catch {
    // Missing summary.tsv is repaired below from available defaults.
  }
  baseCols[1] = validation.ok ? 'OK' : 'SCHEMA_FAIL';
  baseCols[5] = validation.ok ? 'pass' : 'fail';
  await writeFile(summaryPath, `${SUMMARY_HEADER}\n${baseCols.join('\t')}\t${i18nCol}\n`);
}

function defaultRunI18nStage({ slugDir, locales, manifestPath, model, outputDir, fields = [], parallel = 8 }) {
  return new Promise((resolve) => {
    const args = [
      join(FRAMEWORK_DIR, 'cli', 'i18n.mjs'),
      '--manifest', manifestPath,
      '--record', join(slugDir, 'record.json'),
      '--locales', locales.join(','),
      '--output-dir', outputDir || join(slugDir, '_debug', 'i18n'),
      '--parallel', String(parallel),
    ];
    if (model) args.push('--model', model);
    if (fields.length > 0) args.push('--fields', fields.join(','));
    const proc = spawn('node', args, { stdio: 'inherit' });
    proc.on('close', resolve);
  });
}

function defaultRunPostProcessing({ slugDir, manifestPath }) {
  return new Promise((resolve) => {
    const proc = spawn('node', [
      join(FRAMEWORK_DIR, 'cli', 'post.mjs'),
      '--manifest', manifestPath,
      '--slug-dir', slugDir,
    ], { stdio: 'inherit' });
    proc.on('close', resolve);
  });
}

async function defaultValidate(record, manifestPath) {
  const manifest = await loadManifest(manifestPath);
  return await validateRecord(record, manifest);
}

function parsePositiveInt(value, flag) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer (got ${value})`);
  }
  return n;
}

function parseFieldList(value) {
  return String(value || '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}

function parseArgs(args) {
  const opts = {
    batch: false,
    slug: null,
    slugs: [],
    localesArg: '',
    force: false,
    fields: [],
    parallelSlugs: 1,
    i18nParallel: 8,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--batch') {
      opts.batch = true;
    } else if (arg === '--locales') {
      opts.localesArg = args[++i] || '';
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--fields') {
      opts.fields = parseFieldList(args[++i] || '');
    } else if (arg === '--parallel-slugs') {
      opts.parallelSlugs = parsePositiveInt(args[++i], '--parallel-slugs');
    } else if (arg === '--i18n-parallel' || arg === '--parallel') {
      opts.i18nParallel = parsePositiveInt(args[++i], arg);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument ${arg}`);
    } else if (opts.batch) {
      opts.slugs.push(arg);
    } else if (!opts.slug) {
      opts.slug = arg;
    } else {
      throw new Error(`unexpected extra slug ${arg}`);
    }
  }
  return opts;
}

function validateRequestedFields(fields, manifest) {
  if (fields.length === 0) return [];
  const allowed = new Set(manifest.i18n?.translatable_fields || []);
  return fields.filter((field) => !allowed.has(field));
}

async function readSidecar(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readExistingTranslations(i18nDir, locales) {
  const out = {};
  for (const locale of locales) {
    const translation = await readSidecar(join(i18nDir, `${locale}.json`));
    if (translation) out[locale] = translation;
  }
  return out;
}

function assertPartialOnly(partial, fields) {
  const allowedSubset = extractTranslatable(partial || {}, fields);
  if (JSON.stringify(partial || {}) !== JSON.stringify(allowedSubset)) {
    throw new Error('partial i18n output contains fields outside --fields');
  }
}

async function mergePartialSidecars(i18nDir, locales, fields, record, existingTranslations) {
  const sourceSubset = extractTranslatable(record, fields);
  for (const locale of locales) {
    const partialPath = join(i18nDir, `${locale}.json`);
    const partial = await readSidecar(partialPath);
    if (!partial) continue;
    assertPartialOnly(partial, fields);
    const existing = existingTranslations[locale];
    if (!existing) continue;
    assertTranslatedArrayShape(sourceSubset, existing);
    const merged = mergeTranslated(existing, partial);
    await writeFile(partialPath, JSON.stringify(merged, null, 2) + '\n');
  }
}

async function localesNeedingFieldRefresh(slugDir, locales, existingLocales, fields, record, force, manifest) {
  if (force) return locales;
  const hashes = sourceHashesFor(record, fields);
  const meta = await readSourceHashMeta(slugDir, { manifest });
  return locales.filter((code) => !existingLocales.has(code) || !localeHashesMatch(meta, code, hashes));
}

async function writeRunSummary(outputRoot, runId, summary) {
  const dir = join(outputRoot, '.runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'i18n-batch-summary.json'), JSON.stringify(summary, null, 2) + '\n');
}

async function runBatchI18n(opts, ctx, deps) {
  const stderr = ctx.stderr || process.stderr;
  if (!ctx.outputRoot || !ctx.manifestPath || opts.slugs.length === 0) {
    stderr.write('Usage: protocol-info i18n --batch <slug...> [--locales all] [--parallel-slugs N] [--i18n-parallel N]\n');
    return 1;
  }
  const runId = freshRunId();
  const tasks = opts.slugs.map((slug) => async () => {
    const code = await runSingleI18n({ ...opts, slug, batch: false }, ctx, deps);
    return { slug, ok: code === 0, code };
  });
  const settled = await runWithLimit(opts.parallelSlugs, tasks, { collectErrors: true });
  const results = settled.map((entry, index) => {
    if (entry.ok) return entry.value;
    return { slug: opts.slugs[index], ok: false, code: 1, error: entry.error?.message || String(entry.error) };
  });
  const summary = {
    runId,
    ok: results.filter((r) => r.ok).map((r) => r.slug),
    failed: results.filter((r) => !r.ok),
  };
  await writeRunSummary(ctx.outputRoot, runId, summary);
  stderr.write(`i18n batch: ${summary.ok.length}/${results.length} succeeded; summary: ${join(ctx.outputRoot, '.runs', runId, 'i18n-batch-summary.json')}\n`);
  return summary.failed.length === 0 ? 0 : 1;
}

async function runSingleI18n(opts, ctx, deps) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  const {
    runI18nStage,
    runPostProcessing,
    commitRebuild,
    validate,
  } = deps;

  const slug = opts.slug;
  const writeCtx = createWriteCommandContext(outputRoot, { slug, manifestPath, ctx });
  if (!outputRoot || !manifestPath || !slug) {
    stderr.write('Usage: protocol-info i18n <slug> [--locales zh-cn,ja-jp|all] [--fields path,path] [--force]\n');
    return 1;
  }

  const slugDir = join(outputRoot, slug);
  if (!existsSync(join(slugDir, 'record.json'))) {
    stderr.write(`i18n: ${join(slugDir, 'record.json')} does not exist. Run crawl first.\n`);
    return 1;
  }

  const manifest = await loadManifest(manifestPath);
  const unknownFields = validateRequestedFields(opts.fields, manifest);
  if (unknownFields.length > 0) {
    stderr.write(`i18n: unknown translatable field(s): ${unknownFields.join(', ')}\n`);
    return 1;
  }
  const selection = selectedLocales(opts.localesArg, manifest);
  const locales = selection.locales;
  if (selection.unknown.length > 0) {
    stderr.write(`i18n: unknown locale(s): ${selection.unknown.join(', ')}\n`);
    return 1;
  }
  if (locales.length === 0) {
    stderr.write(`i18n: no locales selected (got "${opts.localesArg || 'manifest catalog'}")\n`);
    return 1;
  }

  let rollbackOnError = false;
  try {
    await preflightWritableSlug(outputRoot, slug, { forceOverwrite: !!ctx.forceOverwrite });
    const existing = await loadRecordEnvelope(outputRoot, { slug });
    writeCtx.bindExistingRecord(existing.record);
    const normalized = await writeCtx.normalizeEnvelope(existing);
    const validation = await validate(normalized.record);
    if (!validation.ok) {
      await writeCtx.cleanupCreatedAssets();
      writeValidationFailure(stderr, 'i18n', validation);
      return 1;
    }
    await writeRecordEnvelope(outputRoot, {
      slug,
      provider: writeCtx.expectedProvider(),
      envelope: normalized,
    });
    rollbackOnError = true;
    await seedSidecarsFromFull(slugDir, { manifest });
    const i18nDir = i18nDirFor(slugDir, manifest);
    const existingLocales = await listTranslationSidecars(slugDir, { manifest });
    const fieldMode = opts.fields.length > 0;
    const localesToRun = fieldMode
      ? await localesNeedingFieldRefresh(slugDir, locales, existingLocales, opts.fields, normalized.record, opts.force, manifest)
      : incrementalLocales(locales, existingLocales, opts.force);
    const existingTranslations = fieldMode
      ? await readExistingTranslations(i18nDir, localesToRun)
      : {};
    if (opts.force && !fieldMode) await removeLocaleSidecars(i18nDir, localesToRun);

    if (localesToRun.length > 0) {
      const i18nCode = await runI18nStage({
        slugDir,
        locales: localesToRun,
        manifestPath,
        model: ctx.i18nModel,
        outputDir: i18nDir,
        fields: opts.fields,
        parallel: opts.i18nParallel,
      });
      if (i18nCode !== 0) {
        await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
        stderr.write(`i18n: stage exited ${i18nCode}\n`);
        return i18nCode;
      }
      if (fieldMode) {
        await mergePartialSidecars(i18nDir, localesToRun, opts.fields, normalized.record, existingTranslations);
      }
      await writeLocaleSourceHashes(
        slugDir,
        localesToRun,
        sourceHashesFor(normalized.record, fieldMode ? opts.fields : manifest.i18n.translatable_fields),
        { manifest },
      );
    } else {
      await mkdir(i18nDir, { recursive: true });
      await writeFile(join(i18nDir, 'failures.log'), '');
    }

    const post = await writeCtx.runCanonicalPost(runPostProcessing, slugDir, { manifest });
    if (!post.ok) {
      await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
      stderr.write(`i18n: ${post.error}; rolled back\n`);
      return post.code;
    }
    await updateSlugSummaryI18n(slugDir, slug, await summaryI18nColumn(slugDir, manifest), validation);

    await commitRebuild(outputRoot, {
      slug,
      paths: [
        `${slug}/record.json`,
        `${slug}/findings.json`,
        `${slug}/changes.json`,
        `${slug}/gaps.json`,
        `${slug}/record.full.json`,
        `${slug}/record.import.json`,
        `${slug}/meta.json`,
        ...writeCtx.assetPathsToCommit(),
      ],
      message: i18nMessage(slug, locales, localesToRun, opts.force, opts.fields),
      runId: freshRunId(),
    });
    return 0;
  } catch (err) {
    try {
      if (rollbackOnError) {
        await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
      } else {
        await writeCtx.cleanupCreatedAssets();
      }
    } catch {
      // Preserve original error.
    }
    stderr.write(`i18n: ${err.message}\n`);
    return 1;
  }
}

export default async function i18nCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  let opts;
  try {
    opts = parseArgs(args);
  } catch (err) {
    stderr.write(`i18n: ${err.message}\n`);
    return 1;
  }

  const manifestPath = ctx.manifestPath;
  const deps = {
    runI18nStage: ctx.runI18nStage || defaultRunI18nStage,
    runPostProcessing: ctx.runPostProcessing || defaultRunPostProcessing,
    commitRebuild: ctx.commitAndRebuild || commitAndRebuild,
    validate: ctx.validate || ((record) => defaultValidate(record, manifestPath)),
  };

  if (opts.batch) return await runBatchI18n(opts, ctx, deps);
  return await runSingleI18n(opts, ctx, deps);
}
