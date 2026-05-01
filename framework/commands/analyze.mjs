import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAt, setAt } from '../jsonpath.mjs';
import { loadRecordEnvelope, readJsonDefault, writeRecordEnvelope } from '../record-state.mjs';
import { preflightWritableSlug, rollbackSlugAndCleanup, commitAndRebuild } from '../slug-transaction.mjs';
import { validateRecord } from '../schema-validator.mjs';
import { loadManifest } from '../manifest-loader.mjs';
import { analyzeKey as defaultAnalyzeKey } from '../key-analyzer.mjs';
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

function parseArgs(args) {
  const [slug, jsonpath] = args;
  const opts = {
    slug,
    jsonpath,
    query: '',
    apply: false,
    model: null,
    llmProvider: null,
    maxTurns: null,
    maxBudgetUsd: null,
  };
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--query') {
      opts.query = args[++i] || '';
    } else if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--model') {
      opts.model = args[++i] || null;
    } else if (arg === '--llm-provider') {
      opts.llmProvider = args[++i] || null;
    } else if (arg === '--max-turns') {
      opts.maxTurns = Number(args[++i] || '');
    } else if (arg === '--max-budget') {
      opts.maxBudgetUsd = Number(args[++i] || '');
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return opts;
}

export default async function analyzeCmd(args, ctx = {}) {
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  const analyzeKey = ctx.analyzeKey || defaultAnalyzeKey;
  const validate = ctx.validate || ((record) => defaultValidate(record, manifestPath));
  const runPostProcessing = ctx.runPostProcessing || defaultRunPostProcessing;
  const commitRebuild = ctx.commitAndRebuild || commitAndRebuild;

  let opts;
  try {
    opts = parseArgs(args);
  } catch (err) {
    stderr.write(`analyze: ${err.message}\n`);
    return 1;
  }

  const { slug, jsonpath, query, apply } = opts;
  const writeCtx = createWriteCommandContext(outputRoot, { slug, manifestPath, ctx });
  if (!outputRoot || !manifestPath || !slug || !jsonpath || !query) {
    stderr.write('Usage: protocol-info analyze <slug> <jsonpath> --query <text> [--apply]\n');
    return 1;
  }
  if (opts.maxTurns !== null && (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1)) {
    stderr.write('analyze: --max-turns must be a positive integer\n');
    return 1;
  }
  if (opts.maxBudgetUsd !== null && !(opts.maxBudgetUsd > 0)) {
    stderr.write('analyze: --max-budget must be a positive number\n');
    return 1;
  }

  let rollbackOnError = false;
  try {
    if (apply) {
      await preflightWritableSlug(outputRoot, slug, { forceOverwrite: !!ctx.forceOverwrite });
    }

    const envelope = await loadRecordEnvelope(outputRoot, { slug });
    let currentValue;
    try {
      currentValue = getAt(envelope.record, jsonpath);
    } catch (err) {
      stderr.write(`analyze: ${err.message}\n`);
      return 1;
    }

    const evidence = await readJsonDefault(join(outputRoot, slug, '_debug', 'rootdata.json'), {});
    const proposal = await analyzeKey({
      slug,
      jsonpath,
      query,
      currentValue,
      record: envelope.record,
      evidence,
      manifestPath,
      model: opts.model || ctx.model || null,
      llmProvider: opts.llmProvider || ctx.llmProvider || null,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      budgetLedger: ctx.budgetLedger || null,
    });

    stdout.write(JSON.stringify(proposal, null, 2) + '\n');

    if (!proposal || proposal.ok !== true) {
      stderr.write(`analyze: no applicable proposal: ${proposal?.reason || 'unknown'}\n`);
      return 1;
    }
    if (proposal.path !== jsonpath) {
      stderr.write(`analyze: proposal path "${proposal.path}" does not match requested path "${jsonpath}"\n`);
      return 1;
    }
    if (!apply) {
      return 0;
    }
    if (!Object.hasOwn(proposal, 'proposed_value')) {
      stderr.write('analyze: proposal is missing proposed_value\n');
      return 1;
    }

    setAt(envelope.record, jsonpath, proposal.proposed_value);
    envelope.findings = [...(envelope.findings || []), ...(proposal.findings || [])];
    envelope.changes = [...(envelope.changes || []), ...(proposal.changes || [])];
    envelope.gaps = [...(envelope.gaps || []), ...(proposal.gaps || [])];
    const normalized = await writeCtx.normalizeEnvelope(envelope);

    const validation = await validate(normalized.record);
    if (!validation.ok) {
      await writeCtx.cleanupCreatedAssets();
      writeValidationFailure(stderr, 'analyze', validation);
      return 1;
    }

    await writeRecordEnvelope(outputRoot, { slug, envelope: normalized });
    rollbackOnError = true;
    await invalidateI18nArtifacts(join(outputRoot, slug), { manifestPath });
    const postCode = await runPostProcessing({ slugDir: join(outputRoot, slug), manifestPath });
    if (postCode !== 0) {
      await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
      stderr.write(`analyze: post-processing exited ${postCode}; rolled back\n`);
      return postCode;
    }

    await commitRebuild(outputRoot, {
      slug,
      extraPaths: writeCtx.assetPathsToCommit(),
      message: `analyze(${slug}) ${jsonpath}`,
      runId: freshRunId(),
    });
    return 0;
  } catch (err) {
    if (apply) {
      try {
        if (rollbackOnError) {
          await rollbackSlugAndCleanup(outputRoot, slug, writeCtx.createdLogoAssetPaths);
        } else {
          await writeCtx.cleanupCreatedAssets();
        }
      } catch {
        // Preserve original error.
      }
    }
    stderr.write(`analyze: ${err.message}\n`);
    return 1;
  }
}
