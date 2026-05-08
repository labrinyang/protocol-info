import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';
import { preflightWritableSlug, rollbackSlugAndCleanup, commitAndRebuild } from '../slug-transaction.mjs';
import { loadRecordEnvelope, writeRecordEnvelope } from '../record-state.mjs';
import { validateRecord } from '../schema-validator.mjs';
import { createWriteCommandContext, writeValidationFailure } from '../command-write-context.mjs';
import { normalizeI18nLocaleCode } from '../i18n-locales.mjs';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = dirname(COMMAND_DIR);
const SUMMARY_HEADER = 'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n';

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

function fullFileFor(slugDir, manifest) {
  const out = manifest.output || {};
  return join(slugDir, out.full_filename || 'record.full.json');
}

async function listTranslationSidecars(i18nDir, manifest) {
  const codes = new Set();
  try {
    for (const f of await readdir(i18nDir)) {
      if (!f.endsWith('.json') || f.endsWith('.envelope.json') || f === 'failures.log') continue;
      codes.add(normalizeI18nLocaleCode(f.slice(0, -'.json'.length), manifest));
    }
  } catch {
    // Missing i18n debug directory simply means there are no sidecars yet.
  }
  return codes;
}

async function seedSidecarsFromFull(slugDir, manifest) {
  const fullFile = fullFileFor(slugDir, manifest);
  let full;
  try {
    full = JSON.parse(await readFile(fullFile, 'utf8'));
  } catch {
    return;
  }
  const translations = full?.i18n;
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) return;

  const i18nDir = i18nDirFor(slugDir, manifest);
  await mkdir(i18nDir, { recursive: true });
  for (const [rawCode, translation] of Object.entries(translations)) {
    const code = normalizeI18nLocaleCode(rawCode, manifest);
    if (!code || translation == null) continue;
    const sidecar = join(i18nDir, `${code}.json`);
    if (existsSync(sidecar)) continue;
    await writeFile(sidecar, JSON.stringify(translation, null, 2));
  }
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

function i18nMessage(slug, requestedLocales, localesToRun, force) {
  if (force) return `i18n(${slug}): refresh ${localesToRun.join(', ')}`;
  if (localesToRun.length === requestedLocales.length) return `i18n(${slug}): ${localesToRun.join(', ')}`;
  if (localesToRun.length === 0) return `i18n(${slug}): refresh exports`;
  return `i18n(${slug}): add ${localesToRun.join(', ')}`;
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
  const sidecars = await listTranslationSidecars(i18nDirFor(slugDir, manifest), manifest);
  return sidecars.size > 0 ? `${sidecars.size}/${sidecars.size}` : '-';
}

async function updateSlugSummaryI18n(slugDir, slug, i18nCol) {
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
        value('status', 'OK'),
        value('members', '-'),
        value('funding', '-'),
        value('audits', '-'),
        value('schema', 'pass'),
        value('source', '-'),
        value('api_status', '-'),
      ];
    }
  } catch {
    // Missing summary.tsv is repaired below from available defaults.
  }
  await writeFile(summaryPath, `${SUMMARY_HEADER}\n${baseCols.join('\t')}\t${i18nCol}\n`);
}

function defaultRunI18nStage({ slugDir, locales, manifestPath, model, outputDir }) {
  return new Promise((resolve) => {
    const args = [
      join(FRAMEWORK_DIR, 'cli', 'i18n.mjs'),
      '--manifest', manifestPath,
      '--record', join(slugDir, 'record.json'),
      '--locales', locales.join(','),
      '--output-dir', outputDir || join(slugDir, '_debug', 'i18n'),
    ];
    if (model) args.push('--model', model);
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

export default async function i18nCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  const runI18nStage = ctx.runI18nStage || defaultRunI18nStage;
  const runPostProcessing = ctx.runPostProcessing || defaultRunPostProcessing;
  const commitRebuild = ctx.commitAndRebuild || commitAndRebuild;
  const validate = ctx.validate || ((record) => defaultValidate(record, manifestPath));

  const slug = args[0];
  const writeCtx = createWriteCommandContext(outputRoot, { slug, manifestPath, ctx });
  if (!outputRoot || !manifestPath || !slug) {
    stderr.write('Usage: protocol-info i18n <slug> [--locales zh-cn,ja-jp|all] [--force]\n');
    return 1;
  }

  let localesArg = '';
  let force = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--locales') {
      localesArg = args[++i] || '';
    } else if (args[i] === '--force') {
      force = true;
    } else {
      stderr.write(`i18n: unknown argument ${args[i]}\n`);
      return 1;
    }
  }

  const slugDir = join(outputRoot, slug);
  if (!existsSync(join(slugDir, 'record.json'))) {
    stderr.write(`i18n: ${join(slugDir, 'record.json')} does not exist. Run crawl first.\n`);
    return 1;
  }

  const manifest = await loadManifest(manifestPath);
  const selection = selectedLocales(localesArg, manifest);
  const locales = selection.locales;
  if (selection.unknown.length > 0) {
    stderr.write(`i18n: unknown locale(s): ${selection.unknown.join(', ')}\n`);
    return 1;
  }
  if (locales.length === 0) {
    stderr.write(`i18n: no locales selected (got "${localesArg || 'manifest catalog'}")\n`);
    return 1;
  }

  let rollbackOnError = false;
  try {
    await preflightWritableSlug(outputRoot, slug, { forceOverwrite: !!ctx.forceOverwrite });
    const normalized = await writeCtx.normalizeEnvelope(await loadRecordEnvelope(outputRoot, { slug }));
    const validation = await validate(normalized.record);
    if (!validation.ok) {
      await writeCtx.cleanupCreatedAssets();
      writeValidationFailure(stderr, 'i18n', validation);
      return 1;
    }
    await writeRecordEnvelope(outputRoot, { slug, envelope: normalized });
    rollbackOnError = true;
    await seedSidecarsFromFull(slugDir, manifest);
    const i18nDir = i18nDirFor(slugDir, manifest);
    const existingLocales = await listTranslationSidecars(i18nDir, manifest);
    const localesToRun = incrementalLocales(locales, existingLocales, force);
    if (force) await removeLocaleSidecars(i18nDir, localesToRun);

    if (localesToRun.length > 0) {
      const i18nCode = await runI18nStage({ slugDir, locales: localesToRun, manifestPath, model: ctx.i18nModel, outputDir: i18nDir });
      if (i18nCode !== 0) {
        await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
        stderr.write(`i18n: stage exited ${i18nCode}\n`);
        return i18nCode;
      }
    } else {
      await mkdir(i18nDir, { recursive: true });
      await writeFile(join(i18nDir, 'failures.log'), '');
    }

    const postCode = await runPostProcessing({ slugDir, manifestPath });
    if (postCode !== 0) {
      await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
      stderr.write(`i18n: post-processing exited ${postCode}; rolled back\n`);
      return postCode;
    }
    await updateSlugSummaryI18n(slugDir, slug, await summaryI18nColumn(slugDir, manifest));

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
      message: i18nMessage(slug, locales, localesToRun, force),
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
