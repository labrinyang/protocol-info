import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restore } from '../version-store.mjs';
import { preflightWritableSlug, rollbackSlug, commitAndRebuild } from '../slug-transaction.mjs';
import { validateRecord } from '../schema-validator.mjs';
import { loadManifest } from '../manifest-loader.mjs';
import { invalidateI18nArtifacts } from '../i18n-cache.mjs';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = dirname(COMMAND_DIR);

function freshRunId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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

export default async function restoreCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  const validate = ctx.validate || ((record) => defaultValidate(record, manifestPath));
  const runPostProcessing = ctx.runPostProcessing || defaultRunPostProcessing;
  const commitRebuild = ctx.commitAndRebuild || commitAndRebuild;
  const [slug, sha] = args;

  if (!outputRoot || !manifestPath || !slug || !sha) {
    stderr.write('Usage: protocol-info restore <slug> <sha>\n');
    return 1;
  }

  try {
    await preflightWritableSlug(outputRoot, slug, { forceOverwrite: !!ctx.forceOverwrite });
    await restore(outputRoot, { slug, sha });

    const slugDir = join(outputRoot, slug);
    const recordPath = join(slugDir, 'record.json');
    if (!existsSync(recordPath)) {
      await rollbackSlug(outputRoot, slug);
      stderr.write(`restore: ${recordPath} missing after checkout; rolled back\n`);
      return 1;
    }

    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    const result = await validate(record);
    if (!result.ok) {
      await rollbackSlug(outputRoot, slug);
      stderr.write(`restore: validation failed (${result.errors.length} errors); rolled back\n`);
      for (const e of result.errors.slice(0, 5)) {
        stderr.write(`  ${typeof e === 'string' ? e : `${e.path || '/'}: ${e.message}`}\n`);
      }
      return 1;
    }

    await invalidateI18nArtifacts(slugDir, { manifestPath });
    const postCode = await runPostProcessing({ slugDir, manifestPath });
    if (postCode !== 0) {
      await rollbackSlug(outputRoot, slug);
      stderr.write(`restore: post-processing exited ${postCode}; rolled back\n`);
      return postCode;
    }

    await commitRebuild(outputRoot, {
      slug,
      message: `restore(${slug}) ${sha}`,
      runId: freshRunId(),
    });
    return 0;
  } catch (err) {
    try {
      await rollbackSlug(outputRoot, slug);
    } catch {
      // Preserve original error.
    }
    stderr.write(`restore: ${err.message}\n`);
    return 1;
  }
}
