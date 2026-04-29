import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecordEnvelope, writeRecordEnvelope } from '../record-state.mjs';
import { preflightWritableSlug, rollbackSlugAndCleanup, commitAndRebuild } from '../slug-transaction.mjs';
import { validateRecord } from '../schema-validator.mjs';
import { loadManifest } from '../manifest-loader.mjs';
import { mergeR2 } from '../merger.mjs';
import { runRefreshSubtask as defaultRunRefreshSubtask } from '../refresh-runner.mjs';
import { invalidateI18nArtifacts } from '../i18n-cache.mjs';
import { createWriteCommandContext, writeValidationFailure } from '../command-write-context.mjs';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = dirname(COMMAND_DIR);
const VALID_SUBTASKS = new Set(['metadata', 'team', 'funding', 'audits']);

function parseArgs(args) {
  const opts = {
    slug: args[0],
    subtaskName: args[1],
    llmProvider: null,
  };
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--llm-provider') {
      opts.llmProvider = args[++i] || null;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return opts;
}

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

export default async function refreshCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  let opts;
  try {
    opts = parseArgs(args);
  } catch (err) {
    stderr.write(`refresh: ${err.message}\n`);
    return 1;
  }
  const { slug, subtaskName } = opts;
  const runRefreshSubtask = ctx.runRefreshSubtask || defaultRunRefreshSubtask;
  const merge = ctx.merge || mergeR2;
  const validate = ctx.validate || ((record) => defaultValidate(record, manifestPath));
  const runPostProcessing = ctx.runPostProcessing || defaultRunPostProcessing;
  const commitRebuild = ctx.commitAndRebuild || commitAndRebuild;
  const writeCtx = createWriteCommandContext(outputRoot, { slug, manifestPath, ctx });

  if (!outputRoot || !manifestPath || !slug || !subtaskName) {
    stderr.write('Usage: protocol-info refresh <slug> <subtask> [--llm-provider claude|openai]\n');
    stderr.write('  <subtask> must be one of: metadata, team, funding, audits\n');
    return 1;
  }
  if (!VALID_SUBTASKS.has(subtaskName)) {
    stderr.write(`refresh: unknown subtask "${subtaskName}". Must be one of: ${[...VALID_SUBTASKS].join(', ')}\n`);
    return 1;
  }

  try {
    await preflightWritableSlug(outputRoot, slug, { forceOverwrite: !!ctx.forceOverwrite });
    const prior = await loadRecordEnvelope(outputRoot, { slug });
    const result = await runRefreshSubtask({
      slug,
      subtaskName,
      existingRecord: prior.record,
      manifestPath,
      outputRoot,
      model: ctx.model || null,
      llmProvider: opts.llmProvider || ctx.llmProvider || null,
      budgetLedger: ctx.budgetLedger || null,
      budgetEnforced: !!ctx.budgetLedger,
    });
    if (!result || result.ok !== true || !result.slice) {
      stderr.write(`refresh: subtask failed or returned no slice: ${result?.error || 'unknown'}\n`);
      return 1;
    }

    const refreshed = {
      record: result.slice,
      findings: result.findings || [],
      changes: result.changes || [],
      gaps: result.gaps || [],
    };
    const merged = merge(prior, refreshed);
    const normalized = await writeCtx.normalizeEnvelope(merged);
    const validation = await validate(normalized.record);
    if (!validation.ok) {
      await writeCtx.cleanupCreatedAssets();
      writeValidationFailure(stderr, 'refresh', validation);
      return 1;
    }

    await writeRecordEnvelope(outputRoot, { slug, envelope: normalized });
    await invalidateI18nArtifacts(join(outputRoot, slug), { manifestPath });
    const postCode = await runPostProcessing({ slugDir: join(outputRoot, slug), manifestPath });
    if (postCode !== 0) {
      await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
      stderr.write(`refresh: post-processing exited ${postCode}; rolled back\n`);
      return postCode;
    }

    await commitRebuild(outputRoot, {
      slug,
      extraPaths: writeCtx.assetPathsToCommit(),
      message: `refresh(${slug}): ${subtaskName}`,
      runId: freshRunId(),
    });
    return 0;
  } catch (err) {
    try {
      await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
    } catch {
      // Preserve original error.
    }
    stderr.write(`refresh: ${err.message}\n`);
    return 1;
  }
}
