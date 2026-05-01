import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAt } from '../jsonpath.mjs';
import { loadRecordEnvelope, writeRecordEnvelope } from '../record-state.mjs';
import { preflightWritableSlug, rollbackSlugAndCleanup, commitAndRebuild } from '../slug-transaction.mjs';
import { validateRecord } from '../schema-validator.mjs';
import { loadManifest } from '../manifest-loader.mjs';
import { invalidateI18nArtifacts } from '../i18n-cache.mjs';
import { createWriteCommandContext, writeValidationFailure } from '../command-write-context.mjs';

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

export default async function setCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  const validate = ctx.validate || ((record) => defaultValidate(record, manifestPath));
  const runPostProcessing = ctx.runPostProcessing || defaultRunPostProcessing;
  const commitRebuild = ctx.commitAndRebuild || commitAndRebuild;

  const [slug, jsonpath, valueArg] = args;
  const writeCtx = createWriteCommandContext(outputRoot, { slug, manifestPath, ctx });
  if (!outputRoot || !manifestPath || !slug || !jsonpath || valueArg === undefined) {
    stderr.write('Usage: protocol-info set <slug> <jsonpath> <json-value>\n');
    return 1;
  }

  let value;
  try {
    value = JSON.parse(valueArg);
  } catch (err) {
    stderr.write(`set: <json-value> is not valid JSON: ${err.message}\n`);
    return 1;
  }

  let rollbackOnError = false;
  try {
    await preflightWritableSlug(outputRoot, slug, { forceOverwrite: !!ctx.forceOverwrite });
    const envelope = await loadRecordEnvelope(outputRoot, { slug });
    setAt(envelope.record, jsonpath, value);
    const normalized = await writeCtx.normalizeEnvelope(envelope);

    const result = await validate(normalized.record);
    if (!result.ok) {
      await writeCtx.cleanupCreatedAssets();
      writeValidationFailure(stderr, 'set', result);
      return 1;
    }

    await writeRecordEnvelope(outputRoot, { slug, envelope: normalized });
    rollbackOnError = true;
    await invalidateI18nArtifacts(join(outputRoot, slug), { manifestPath });
    const postCode = await runPostProcessing({ slugDir: join(outputRoot, slug), manifestPath });
    if (postCode !== 0) {
      await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
      stderr.write(`set: post-processing exited ${postCode}; rolled back\n`);
      return postCode;
    }

    await commitRebuild(outputRoot, {
      slug,
      extraPaths: writeCtx.assetPathsToCommit(),
      message: `set(${slug}) ${jsonpath}`,
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
      // Preserve the original error.
    }
    stderr.write(`set: ${err.message}\n`);
    return 1;
  }
}
