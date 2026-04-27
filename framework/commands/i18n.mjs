import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../manifest-loader.mjs';
import { preflightWritableSlug, rollbackSlug, commitAndRebuild } from '../slug-transaction.mjs';
import { clearI18nSidecars } from '../i18n-cache.mjs';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = dirname(COMMAND_DIR);

function freshRunId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function selectedLocales(localesArg, manifest) {
  const catalog = (manifest.i18n?.locale_catalog || []).map((e) => e.code).filter(Boolean);
  if (!localesArg || localesArg === 'all') return catalog;
  if (localesArg === 'none') return [];
  return localesArg.split(',').map((s) => s.trim()).filter(Boolean);
}

function defaultRunI18nStage({ slugDir, locales, manifestPath, model }) {
  return new Promise((resolve) => {
    const args = [
      join(FRAMEWORK_DIR, 'cli', 'i18n.mjs'),
      '--manifest', manifestPath,
      '--record', join(slugDir, 'record.json'),
      '--locales', locales.join(','),
      '--output-dir', join(slugDir, '_debug', 'i18n'),
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

export default async function i18nCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  const runI18nStage = ctx.runI18nStage || defaultRunI18nStage;
  const runPostProcessing = ctx.runPostProcessing || defaultRunPostProcessing;
  const commitRebuild = ctx.commitAndRebuild || commitAndRebuild;

  const slug = args[0];
  if (!outputRoot || !manifestPath || !slug) {
    stderr.write('Usage: protocol-info i18n <slug> [--locales zh_CN,ja_JP|all]\n');
    return 1;
  }

  let localesArg = '';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--locales') {
      localesArg = args[++i] || '';
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
  const locales = selectedLocales(localesArg, manifest);
  if (locales.length === 0) {
    stderr.write(`i18n: no locales selected (got "${localesArg || 'manifest catalog'}")\n`);
    return 1;
  }

  try {
    await preflightWritableSlug(outputRoot, slug, { forceOverwrite: !!ctx.forceOverwrite });
    await clearI18nSidecars(slugDir, { manifest });
    const i18nCode = await runI18nStage({ slugDir, locales, manifestPath, model: ctx.i18nModel });
    if (i18nCode !== 0) {
      stderr.write(`i18n: stage exited ${i18nCode}\n`);
      return i18nCode;
    }

    const postCode = await runPostProcessing({ slugDir, manifestPath });
    if (postCode !== 0) {
      await rollbackSlug(outputRoot, slug);
      stderr.write(`i18n: post-processing exited ${postCode}; rolled back\n`);
      return postCode;
    }

    await commitRebuild(outputRoot, {
      slug,
      paths: [`${slug}/record.full.json`, `${slug}/record.import.json`, `${slug}/meta.json`],
      message: `i18n(${slug}): ${locales.join(', ')}`,
      runId: freshRunId(),
    });
    return 0;
  } catch (err) {
    try {
      await rollbackSlug(outputRoot, slug);
    } catch {
      // Preserve original error.
    }
    stderr.write(`i18n: ${err.message}\n`);
    return 1;
  }
}
