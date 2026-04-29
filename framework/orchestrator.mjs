// framework/orchestrator.mjs — Node-side port of run.sh's run_one() + dispatcher.
//
// Sequences (per provider):
//   fetch.mjs (per-fetcher env gating)
//     -> r1.mjs
//     -> evidence-diff.mjs
//     -> r2.mjs (no session resume — see project_legacy_r2_incompatible_with_fanout)
//     -> normalize.mjs
//     -> schema-validator.mjs
//     -> per-slug summary row + meta.json
//
// After all providers complete (in run(), not runOne()):
//   - i18n stage across OK slugs (if --i18n requested + non-empty)
//   - post.mjs across OK slugs (always, on OK slugs)
//   - merge per-slug summary rows + i18n column → summary.tsv
//
// Calls every CLI shim via child_process.spawn — never inline-imports — so
// behavior matches the bash run.sh exactly. See `framework/cli/*.mjs`.

import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, readdir, stat, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './manifest-loader.mjs';
import { runWithLimit } from './parallel-runner.mjs';
import { buildOutBrowser } from './out-browser.mjs';
import { ensureRepo, commit, isClean, resetSlugToHead } from './version-store.mjs';
import { invalidateI18nArtifacts } from './i18n-cache.mjs';
import { cleanupCreatedLogoAssets } from './logo-assets.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(FRAMEWORK_DIR);
// Low-frequency plain-text heartbeat for Claude Code / terminal runs. Avoid
// ANSI, carriage returns, or progress bars because slash commands capture text.
const DEFAULT_PROGRESS_HEARTBEAT_MS = 60_000;

// ── child_process helpers ───────────────────────────────────────────────────

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function runNode(scriptPath, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let heartbeat = null;
    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_PROGRESS_HEARTBEAT_MS;
    if (opts.progressLabel && heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        process.stderr.write(`${opts.progressLabel} still running (${formatElapsed(Date.now() - startedAt)})\n`);
      }, heartbeatMs);
      heartbeat.unref?.();
    }
    const finish = (result) => {
      if (heartbeat) clearInterval(heartbeat);
      resolvePromise(result);
    };
    const proc = spawn('node', [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (opts.passthroughStdout) process.stdout.write(d);
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (opts.passthroughStderr) process.stderr.write(d);
    });
    proc.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    proc.on('error', (err) => finish({ code: 1, stdout, stderr: stderr + err.message }));
  });
}

const callCli = (name, args, opts) =>
  runNode(join(FRAMEWORK_DIR, 'cli', `${name}.mjs`), args, opts);
const callValidator = (args, opts) =>
  runNode(join(FRAMEWORK_DIR, 'schema-validator.mjs'), args, opts);

// ── tiny utility: tail last N lines of a string ─────────────────────────────

function tailLines(s, n) {
  if (!s) return '';
  const lines = s.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function logProvider(slug, message) {
  console.log(`  [${slug}] ${message}`);
}

function formatUsd(n) {
  return `$${(Number(n) || 0).toFixed(4)}`;
}

async function fileNonEmpty(path) {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function readJsonSafe(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function cleanupLogoAssetsFile(outputRoot, path) {
  const created = await readJsonSafe(path, []);
  if (Array.isArray(created) && created.length > 0) {
    await cleanupCreatedLogoAssets(outputRoot, created);
  }
}

async function sumEnvelopeTelemetry(dir, pattern = /\.envelope\.json$/) {
  let cost = 0;
  let turns = 0;
  try {
    for (const f of await readdir(dir)) {
      if (!pattern.test(f)) continue;
      const env = await readJsonSafe(join(dir, f), null);
      if (!env) continue;
      if (typeof env.total_cost_usd === 'number') cost += env.total_cost_usd;
      if (typeof env.num_turns === 'number') turns += env.num_turns;
    }
  } catch { /* directory may not exist */ }
  return { cost_usd: cost, turns };
}

function roundBudget(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function capBudget(n) {
  return Math.floor(n * 1_000_000) / 1_000_000;
}

export function computeBudgetPlan(manifest, { maxBudget = null, i18nLocaleCount = 0 } = {}) {
  const r1Total = (manifest.subtasks || [])
    .reduce((sum, st) => sum + Number(st.max_budget_usd || 0), 0);
  const r2Rounds = manifest.reconcile?.enabled === false
    ? 0
    : Math.max(1, Number(manifest.reconcile?.max_research_rounds || 1));
  const r2PerRound = Number(manifest.reconcile?.max_budget_usd || 0);
  const r2Total = r2PerRound * r2Rounds;
  const i18nPerLocale = Number(manifest.i18n?.max_budget_usd_per_call || 0);
  const i18nTotal = i18nPerLocale * Math.max(0, i18nLocaleCount || 0);
  const defaultTotal = r1Total + r2Total + i18nTotal;
  const scale = maxBudget != null && defaultTotal > 0
    ? Math.min(1, Number(maxBudget) / defaultTotal)
    : 1;

  const effective = {
    r1_total: capBudget(r1Total * scale),
    r2_total: capBudget(r2Total * scale),
    i18n_total: capBudget(i18nTotal * scale),
  };
  effective.total = capBudget(effective.r1_total + effective.r2_total + effective.i18n_total);

  return {
    mode: maxBudget == null ? 'manifest_defaults' : 'single_provider_total_cap',
    user_max_budget_usd: maxBudget == null ? null : Number(maxBudget),
    scale: roundBudget(scale),
    r2_rounds: r2Rounds,
    i18n_locale_count: Math.max(0, i18nLocaleCount || 0),
    defaults: {
      r1_total: roundBudget(r1Total),
      r2_total: roundBudget(r2Total),
      i18n_total: roundBudget(i18nTotal),
      total: roundBudget(defaultTotal),
    },
    effective,
  };
}

// Mirror of run.sh slugify(): lowercase, [^a-z0-9]→-, collapse repeats, trim.
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function protocolDir(outputRoot, slug) {
  return join(outputRoot, slug);
}

export function runIndexDir(outputRoot, runId) {
  return join(outputRoot, '.runs', runId);
}

export async function appendRunsLog(outputRoot, { runId, slugs, outcome }) {
  const ts = new Date().toISOString();
  const line = `${ts}\t${runId}\t${slugs.join(',')}\t${outcome}\n`;
  await appendFile(join(outputRoot, '.runs.log'), line);
}

export async function guardClobber(outputRoot, slug, { forceOverwrite }) {
  if (forceOverwrite) return;
  const clean = await isClean(outputRoot, { slug });
  if (!clean) {
    throw new Error(
      `${slug}: uncommitted changes in out/${slug}/ — refusing to overwrite. ` +
      `Commit or discard them first, or pass --force-overwrite.`
    );
  }
}

async function rollbackFailedSlug(outputRoot, slug) {
  await resetSlugToHead(outputRoot, { slug });
}

async function commitOkSlugs(outputRoot, okSlugs, runId) {
  // INVARIANT: this loop runs SEQUENTIALLY, AFTER the parallel runWithLimit
  // call above and AFTER post-processing has produced all canonical artifacts.
  // Do NOT inline these commits into runOne() or wrap them in Promise.all() —
  // concurrent writes to out/.git/index will race under --parallel >1.
  for (const slug of okSlugs) {
    const message = `crawl(${slug}): R1+R2 ok`;
    const assetPaths = await readJsonSafe(
      join(outputRoot, slug, '_debug', 'normalize.logo-assets-to-commit.json'),
      [],
    );
    await commit(outputRoot, { paths: [`${slug}/`, ...assetPaths], message, runId });
  }
}

// ── runOne: full per-provider pipeline ──────────────────────────────────────

export async function runOne({
  manifestPath,
  manifest,
  provider,
  outputRoot = null,
  runId = null,
  runMetaDir = null,
  runDir = null,
  index,
  total,
  options = {},
}) {
  if (!outputRoot) {
    if (!runDir) throw new Error('runOne() requires outputRoot + runId');
    outputRoot = dirname(runDir);
    runId = runId || basename(runDir);
  }
  if (!runId) throw new Error('runOne() requires runId');
  runMetaDir = runMetaDir || runIndexDir(outputRoot, runId);

  const slug = provider.slug;
  const providerKey = provider.provider || slug;
  const display = provider.displayName;
  const type = provider.type || '';
  const hints = provider.hints || '';
  const rootdataId = provider.rootdataId != null ? String(provider.rootdataId) : '';

  const indexLabel = String(index).padStart(4, '0');
  const summaryRowsDir = join(runMetaDir, '.summary-rows');
  const summaryRowFile = join(summaryRowsDir, `${indexLabel}-${slug}.tsv`);
  const callStage = options.callCli || callCli;
  const callSchemaValidator = options.callValidator || callValidator;

  if (type) {
    console.log(`[${index}/${total}] ${slug} (${type})`);
  } else {
    console.log(`[${index}/${total}] ${slug} (type: model-inferred)`);
  }

  if (options.dryRun) {
    // r1.mjs has no --dry-run flag today (per task instructions). Bail with
    // the provider listing so the user can see what would have been crawled.
    console.log(`  -> dry-run: would crawl ${slug} (display="${display}")`);
    return { slug, status: 'DRY_RUN' };
  }

  await guardClobber(outputRoot, slug, { forceOverwrite: !!options.forceOverwrite });
  await mkdir(summaryRowsDir, { recursive: true });
  const slugDir = protocolDir(outputRoot, slug);
  const debugDir = join(slugDir, '_debug');
  const r1DebugDir = join(debugDir, 'r1');
  const r2DebugDir = join(debugDir, 'r2');
  await mkdir(r1DebugDir, { recursive: true });

  const recordPath = join(slugDir, 'record.json');
  const findingsPath = join(slugDir, 'findings.json');
  const gapsPath = join(slugDir, 'gaps.json');
  const handoffPath = join(slugDir, 'handoff_notes.json');
  const changesPath = join(slugDir, 'changes.json');
  const metaPath = join(slugDir, 'meta.json');
  const rootdataPkt = join(debugDir, 'rootdata.json');
  logProvider(slug, `output: ${slugDir}`);

  // ── Phase 1: fetchers (per-fetcher env gating happens inside dispatcher) ─

  logProvider(slug, 'R0 fetch evidence started');
  const fetchArgs = [
    '--manifest', manifestPath,
    '--slug', slug,
    '--display-name', display,
    '--hints', hints,
    '--output', rootdataPkt,
  ];
  if (rootdataId) fetchArgs.push('--rootdata-id', rootdataId);
  const fetchRes = await callStage('fetch', fetchArgs);
  const apiExit = fetchRes.code;
  if (fetchRes.stderr) {
    try {
      await writeFile(join(debugDir, 'fetch.stderr.log'), fetchRes.stderr);
    } catch { /* best effort */ }
  }

  // Read dispatcher's fetcher_status for accurate per-fetcher reporting; the
  // summary column reflects rootdata specifically (other fetchers' status is
  // visible inside the packet for debugging).
  const evidencePacket = await readJsonSafe(rootdataPkt, {});
  const rootdataStatus = evidencePacket?.fetcher_status?.rootdata || (apiExit === 0 ? 'ok' : `exit_${apiExit}`);
  const apiStatus = rootdataStatus === 'ok'
    ? 'ok'
    : (rootdataStatus.startsWith('skipped') ? 'disabled' : `failed`);
  const rootdataOk = rootdataStatus === 'ok';
  const defillamaStatus = evidencePacket?.fetcher_status?.defillama || 'unknown';
  logProvider(slug, `R0 fetch evidence done: rootdata=${apiStatus}, defillama=${defillamaStatus}`);
  let finalSource = 'r1';
  let r1Cost = 0;
  let r1Turns = 0;
  let r2Cost = 0;
  let r2Turns = 0;
  const memberCandidatesFed = Array.isArray(evidencePacket?.rootdata?.member_candidates)
    ? evidencePacket.rootdata.member_candidates.length
    : 0;
  let fundingSeverity = 'none';

  const writeMeta = async (runStatus, extra = {}) => {
    const meta = {
      status: runStatus,
      r1: { cost_usd: r1Cost, turns: r1Turns },
      r2: r2Turns > 0 ? { cost_usd: r2Cost, turns: r2Turns } : null,
      source_used: finalSource,
      rootdata: apiStatus === 'disabled'
        ? null
        : apiStatus === 'ok'
          ? {
              used: true,
              member_candidates_fed: memberCandidatesFed,
              funding_discrepancy_severity: fundingSeverity,
            }
          : { used: false, status: apiStatus },
      budget: options.budgetPlan || null,
      i18n: null,
      ...extra,
    };
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  };

  // ── Phase 2: R1 fan-out ──────────────────────────────────────────────────

  const r1Args = [
    '--manifest', manifestPath,
    '--slug', slug,
    '--provider', providerKey,
    '--display-name', display,
    '--hints', hints,
    '--evidence', rootdataPkt,
    '--record-out', recordPath,
    '--debug-dir', r1DebugDir,
    '--findings-out', findingsPath,
    '--gaps-out', gapsPath,
    '--handoff-out', handoffPath,
  ];
  if (type) r1Args.push('--type', type);
  if (options.model) r1Args.push('--model', options.model);
  if (options.maxTurns) r1Args.push('--max-turns', String(options.maxTurns));
  if (options.budgetPlan?.effective?.r1_total) {
    r1Args.push('--max-budget', String(options.budgetPlan.effective.r1_total));
  }

  const r1SubtaskCount = (manifest._abs?.subtasks || manifest.subtasks || []).length;
  const r1Budget = options.budgetPlan?.effective?.r1_total;
  logProvider(slug, `R1 fan-out started: ${r1SubtaskCount} subtasks${r1Budget ? `, budget=${formatUsd(r1Budget)}` : ''}`);
  const r1Res = await callStage('r1', r1Args, { progressLabel: `[${slug}] R1 fan-out` });
  const r1Stderr = r1Res.stderr || '';
  try {
    await writeFile(join(debugDir, 'r1.stderr.log'), r1Stderr);
  } catch { /* best effort */ }

  if (r1Res.code !== 0) {
    const t = await sumEnvelopeTelemetry(r1DebugDir);
    r1Cost = t.cost_usd;
    r1Turns = t.turns;
    console.log(`  -> CRAWL_FAIL (exit ${r1Res.code}); see ${join(debugDir, 'r1.stderr.log')}`);
    if (r1Stderr) {
      process.stderr.write('     --- last stderr lines ---\n');
      process.stderr.write(tailLines(r1Stderr, 20).split('\n').map(l => '     ' + l).join('\n') + '\n\n');
    }
    await writeFile(summaryRowFile, `${slug}\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t${apiStatus}\n`);
    await writeMeta('CRAWL_FAIL', { failure_stage: 'r1', error: `r1 exit ${r1Res.code}` });
    await rollbackFailedSlug(outputRoot, slug);
    return { slug, status: 'CRAWL_FAIL' };
  }

  if (!(await fileNonEmpty(recordPath))) {
    const t = await sumEnvelopeTelemetry(r1DebugDir);
    r1Cost = t.cost_usd;
    r1Turns = t.turns;
    console.log(`  -> CRAWL_FAIL (no slice produced by r1.mjs)`);
    if (r1Stderr) {
      process.stderr.write(tailLines(r1Stderr, 20).split('\n').map(l => '     ' + l).join('\n') + '\n');
    }
    await writeFile(summaryRowFile, `${slug}\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t-\n`);
    await writeMeta('CRAWL_FAIL', { failure_stage: 'r1', error: 'r1 produced no record' });
    await rollbackFailedSlug(outputRoot, slug);
    return { slug, status: 'CRAWL_FAIL' };
  }

  // ── R1 telemetry: aggregate across ALL subtask envelopes ────────────────

  const r1Telemetry = await sumEnvelopeTelemetry(r1DebugDir);
  r1Cost = r1Telemetry.cost_usd;
  r1Turns = r1Telemetry.turns;
  const r1Status = await readJsonSafe(join(r1DebugDir, 'r1-status.json'), null);
  const r1Ok = Array.isArray(r1Status?.subtasks) ? r1Status.subtasks.filter((s) => s.ok).length : null;
  const r1Total = Array.isArray(r1Status?.subtasks) ? r1Status.subtasks.length : null;
  const r1ResultText = r1Ok == null ? 'completed' : `${r1Ok}/${r1Total} subtasks ok`;
  logProvider(slug, `R1 fan-out done: ${r1ResultText}, cost=${formatUsd(r1Cost)}, turns=${r1Turns}`);
  if (Array.isArray(r1Status?.failed_subtasks) && r1Status.failed_subtasks.length > 0) {
    const failed = r1Status.failed_subtasks.map((f) => f.name).filter(Boolean).join(', ');
    if (failed) logProvider(slug, `R1 partial gaps: failed subtasks=${failed}`);
  }

  // (Pre-R2 validated_overrides mutation removed: those overrides remain in
  // the evidence packet and are arbitrated by R2's audit-first guard, which
  // honors R1's high-confidence findings via merger.mergeR2.)

  // ── Phase 3.5: evidence-diff enrichment ──────────────────────────────────

  if (rootdataOk && existsSync(rootdataPkt)) {
    const r = await callStage('evidence-diff', [
      '--evidence-in', rootdataPkt,
      '--record-in', recordPath,
      '--evidence-out', rootdataPkt,
    ]);
    if (r.stderr) {
      try {
        await writeFile(join(debugDir, 'evidence-diff.stderr.log'), r.stderr);
      } catch { /* best effort */ }
    }
    const enriched = await readJsonSafe(rootdataPkt, {});
    fundingSeverity = enriched?.evidence_diff?.funding?.severity || 'none';
    logProvider(slug, `evidence diff done: funding_discrepancy=${fundingSeverity}`);
  }

  // ── Phase 3.6: R2 reconcile ──────────────────────────────────────────────

  const recordR2 = recordPath + '.r2';
  const findingsR2 = findingsPath + '.r2';
  const changesR2 = changesPath + '.r2';
  const gapsR2 = gapsPath + '.r2';

  const r2Args = [
    '--manifest', manifestPath,
    '--record-in', recordPath,
    '--findings-in', findingsPath,
    '--gaps-in', gapsPath,
    '--handoff-in', handoffPath,
    '--evidence', rootdataPkt,
    '--record-out', recordR2,
    '--findings-out', findingsR2,
    '--changes-out', changesR2,
    '--gaps-out', gapsR2,
    '--debug-dir', r2DebugDir,
  ];
  if (options.model) r2Args.push('--model', options.model);
  if (options.maxTurns) r2Args.push('--max-turns', String(options.maxTurns));
  if (options.budgetPlan?.effective?.r2_total) {
    r2Args.push('--max-budget', String(options.budgetPlan.effective.r2_total));
  }
  await mkdir(r2DebugDir, { recursive: true });
  const r2Budget = options.budgetPlan?.effective?.r2_total;
  logProvider(slug, `R2 reconcile started${r2Budget ? `: budget=${formatUsd(r2Budget)}` : ''}`);
  const r2Res = await callStage('r2', r2Args, { progressLabel: `[${slug}] R2 reconcile` });
  if (r2Res.stderr) {
    try {
      await writeFile(join(debugDir, 'r2.stderr.log'), r2Res.stderr);
    } catch { /* best effort */ }
  }

  if (r2Res.code === 0 && (await fileNonEmpty(recordR2))) {
    // Promote R2 sidecars
    await rename(recordR2, recordPath);
    if (existsSync(findingsR2)) await rename(findingsR2, findingsPath);
    if (existsSync(changesR2)) await rename(changesR2, changesPath);
    if (existsSync(gapsR2)) await rename(gapsR2, gapsPath);
    finalSource = 'r2';

    // Aggregate r2 cost + turns across rounds
    const t = await sumEnvelopeTelemetry(r2DebugDir, /^reconcile\.round\d+\.envelope\.json$/);
    r2Cost = t.cost_usd;
    r2Turns = t.turns;
    logProvider(slug, `R2 reconcile done: promoted R2 record, cost=${formatUsd(r2Cost)}, turns=${r2Turns}`);
  } else {
    const t = await sumEnvelopeTelemetry(r2DebugDir, /^reconcile\.round\d+\.envelope\.json$/);
    r2Cost = t.cost_usd;
    r2Turns = t.turns;
    logProvider(slug, `R2 reconcile fallback: keeping R1 record, cost=${formatUsd(r2Cost)}, turns=${r2Turns}`);
    process.stderr.write(`  -> R2 reconcile failed (exit ${r2Res.code}); keeping R1 record\n`);
    for (const p of [recordR2, findingsR2, changesR2, gapsR2]) {
      try { await unlink(p); } catch { /* best effort */ }
    }
  }

  // ── Phase 4: changes.json safety net + normalize.mjs ─────────────────────

  if (!existsSync(changesPath)) {
    await writeFile(changesPath, '[]');
  }

  const recordNorm = recordPath + '.normalized';
  const changesNorm = changesPath + '.normalized';
  const gapsNorm = gapsPath + '.normalized';
  const createdAssetsNorm = join(debugDir, 'normalize.created-logo-assets.json');
  const assetsToCommitNorm = join(debugDir, 'normalize.logo-assets-to-commit.json');

  const normRes = await callStage('normalize', [
    '--manifest', manifestPath,
    '--record-in', recordPath,
    '--evidence', rootdataPkt,
    '--changes-in', changesPath,
    '--gaps-in', gapsPath,
    '--record-out', recordNorm,
    '--changes-out', changesNorm,
    '--gaps-out', gapsNorm,
    '--output-root', outputRoot,
    '--slug-dir', slugDir,
    '--created-assets-out', createdAssetsNorm,
    '--assets-to-commit-out', assetsToCommitNorm,
  ]);
  if (normRes.stderr) {
    try {
      await writeFile(join(debugDir, 'normalize.stderr.log'), normRes.stderr);
    } catch { /* best effort */ }
  }

  if (normRes.code === 0 && (await fileNonEmpty(recordNorm))) {
    await rename(recordNorm, recordPath);
    if (existsSync(changesNorm)) await rename(changesNorm, changesPath);
    if (existsSync(gapsNorm)) await rename(gapsNorm, gapsPath);
  } else {
    await cleanupLogoAssetsFile(outputRoot, createdAssetsNorm);
    process.stderr.write(`  -> normalizer failed (exit ${normRes.code}); keeping pre-normalize record\n`);
    for (const p of [recordNorm, changesNorm, gapsNorm]) {
      try { await unlink(p); } catch { /* best effort */ }
    }
  }

  // ── Schema validation ────────────────────────────────────────────────────

  const schemaPath = manifest._abs.full_schema;
  const schemaRes = await callSchemaValidator(['--schema', schemaPath, recordPath]);
  // Validator emits OK/FAIL on stdout; preserve stderr+stdout for debug.
  const schemaCombined = (schemaRes.stdout || '') + (schemaRes.stderr || '');

  // ── Counts ──────────────────────────────────────────────────────────────

  const recordObj = await readJsonSafe(recordPath, {});
  const members = Array.isArray(recordObj?.members) ? recordObj.members.length : '-';
  const funding = Array.isArray(recordObj?.fundingRounds) ? recordObj.fundingRounds.length : '-';
  const audits = Array.isArray(recordObj?.audits?.items) ? recordObj.audits.items.length : '-';

  let status;
  if (schemaRes.code === 0) {
    status = 'OK';
    console.log(`  -> OK  members=${members} funding=${funding} audits=${audits} source=${finalSource}`);
  } else {
    status = 'SCHEMA_FAIL';
    console.log(`  -> SCHEMA_FAIL  members=${members} funding=${funding} audits=${audits} source=${finalSource}`);
    try {
      await writeFile(join(debugDir, 'schema.stderr.log'), schemaCombined);
    } catch { /* best effort */ }
    if (schemaCombined) {
      process.stderr.write(schemaCombined.split('\n').map(l => '        ' + l).join('\n') + '\n');
    }
  }

  await writeFile(
    summaryRowFile,
    `${slug}\t${status}\t${members}\t${funding}\t${audits}\t${schemaRes.code === 0 ? 'pass' : 'fail'}\t${finalSource}\t${apiStatus}\n`,
  );

  // ── meta.json ───────────────────────────────────────────────────────────

  await writeMeta(status, { schema: schemaRes.code === 0 ? 'pass' : 'fail' });
  if (status !== 'OK') {
    await cleanupLogoAssetsFile(outputRoot, createdAssetsNorm);
    await rollbackFailedSlug(outputRoot, slug);
  }

  return { slug, status, members, funding, audits, source: finalSource, api_status: apiStatus };
}

// ── i18n selection resolver ─────────────────────────────────────────────────

export function resolveI18nSelection(i18nArg, manifest) {
  if (!i18nArg) return [];
  if (i18nArg === 'none') return [];
  let raw = [];
  if (i18nArg === 'all') {
    raw = (manifest?.i18n?.locale_catalog || []).map((e) => e.code);
  } else {
    raw = i18nArg.split(',');
  }
  const out = [];
  for (const code of raw) {
    const trimmed = code.replace(/\s+/g, '');
    if (trimmed) out.push(trimmed);
  }
  return out;
}

// ── run: dispatcher + post-loop (i18n + post.mjs + summary.tsv) ─────────────

export async function run({
  manifestPath,
  providers,
  outputRoot = null,
  runId = null,
  runDir = null,
  parallelism = 1,
  dryRun = false,
  options = {},
}) {
  const manifest = await loadManifest(manifestPath);
  if (!outputRoot) {
    if (!runDir) throw new Error('run() requires outputRoot + runId');
    outputRoot = dirname(runDir);
    runId = runId || basename(runDir);
  }
  if (!runId) throw new Error('run() requires runId');
  const runMetaDir = runIndexDir(outputRoot, runId);

  // Resolve effective R1/R2 model: explicit --model wins, else manifest's
  // model_default, else null (Claude CLI's own default). i18n is unaffected
  // and continues to read manifest.i18n.model_default (Haiku) via the i18n CLI.
  if (!options.model && manifest.model_default) {
    options = { ...options, model: manifest.model_default };
  }

  await mkdir(outputRoot, { recursive: true });
  await ensureRepo(outputRoot);
  if (!dryRun) {
    await mkdir(runMetaDir, { recursive: true });
    await mkdir(join(runMetaDir, '.summary-rows'), { recursive: true });
    await mkdir(join(runMetaDir, '.worker-logs'), { recursive: true });
  }

  // Header for summary.tsv (rewritten at the end with i18n column merge)
  const summaryFile = join(runMetaDir, 'summary.tsv');

  const total = providers.length;
  const effectiveParallelism = dryRun ? 1 : Math.max(1, parallelism | 0);
  const i18nSelected = resolveI18nSelection(options.i18nArg, manifest);
  const callStage = options.callCli || callCli;
  const budgetPlan = computeBudgetPlan(manifest, {
    maxBudget: options.maxBudget,
    i18nLocaleCount: i18nSelected.length,
  });

  const tasks = providers.map((provider, i) => async () => {
    return runOne({
      manifestPath,
      manifest,
      provider,
      outputRoot,
      runId,
      runMetaDir,
      index: i + 1,
      total,
      options: { ...options, dryRun, budgetPlan },
    });
  });

  if (effectiveParallelism > 1) {
    console.log(`Dispatching ${total} providers with parallelism=${effectiveParallelism}...`);
  }
  const workerResults = await runWithLimit(effectiveParallelism, tasks, { collectErrors: true });
  const rawWorkerFailures = workerResults
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && !r.ok);

  if (dryRun) {
    if (rawWorkerFailures.length > 0) {
      throw new Error(`${rawWorkerFailures.length} dry-run worker(s) crashed`);
    }
    return { outputRoot, runId, runDir: runMetaDir, ok: providers.length, failed: 0 };
  }

  const workerFailures = [];
  for (const { r, i } of rawWorkerFailures) {
    const provider = providers[i];
    const slug = provider.slug;
    const indexLabel = String(i + 1).padStart(4, '0');
    const summaryRowFile = join(runMetaDir, '.summary-rows', `${indexLabel}-${slug}.tsv`);
    const slugDir = protocolDir(outputRoot, slug);
    const debugDir = join(slugDir, '_debug');
    await mkdir(debugDir, { recursive: true });
    const error = r.error?.stack || r.error?.message || String(r.error || 'unknown worker failure');
    await writeFile(join(runMetaDir, '.worker-logs', `${indexLabel}-${slug}.log`), error + '\n');
    await writeFile(join(debugDir, 'worker.stderr.log'), error + '\n');
    await writeFile(summaryRowFile, `${slug}\tCRAWL_FAIL\t-\t-\t-\t-\tworker\t-\n`);
    await writeFile(join(slugDir, 'meta.json'), JSON.stringify({
      status: 'CRAWL_FAIL',
      failure_stage: 'worker',
      error: error.slice(0, 1000),
      r1: { cost_usd: 0, turns: 0 },
      r2: null,
      source_used: 'worker',
      rootdata: null,
      budget: budgetPlan,
      i18n: null,
    }, null, 2));
    await rollbackFailedSlug(outputRoot, slug);
    workerFailures.push({ slug, error });
  }

  // ── Collect OK slugs ─────────────────────────────────────────────────────

  const summaryRowsDir = join(runMetaDir, '.summary-rows');
  const okSlugs = [];
  let rowFiles = [];
  try {
    rowFiles = (await readdir(summaryRowsDir)).filter((f) => f.endsWith('.tsv')).sort();
  } catch { /* none */ }
  for (const f of rowFiles) {
    const content = await readFile(join(summaryRowsDir, f), 'utf8');
    const cols = content.split('\n')[0].split('\t');
    if (cols[1] === 'OK') okSlugs.push(cols[0]);
  }

  const failedCount = workerFailures.length + (rawWorkerFailures.length - workerFailures.length);
  await appendRunsLog(outputRoot, {
    runId,
    slugs: providers.map((p) => p.slug),
    outcome: `${okSlugs.length} OK / ${failedCount} fail`,
  });

  // ── i18n stage ───────────────────────────────────────────────────────────

  for (const slug of okSlugs) {
    await invalidateI18nArtifacts(protocolDir(outputRoot, slug), { manifest });
  }

  if (okSlugs.length > 0 && i18nSelected.length > 0) {
    console.log('');
    console.log('=== i18n translation (Haiku) ===');
    console.log(`Records:  ${okSlugs.length}`);
    console.log(`Locales:  ${i18nSelected.length} (${i18nSelected.join(' ')})`);
    console.log(`Parallel: ${options.i18nParallel ?? 8}`);
    console.log(`Model:    ${options.i18nModel ?? '(default)'}`);
    console.log('');
    for (const slug of okSlugs) {
      const args = [
        '--manifest', manifestPath,
        '--record', join(protocolDir(outputRoot, slug), 'record.json'),
        '--locales', i18nSelected.join(','),
        '--output-dir', join(protocolDir(outputRoot, slug), '_debug', 'i18n'),
        '--parallel', String(options.i18nParallel ?? 8),
      ];
      if (options.i18nModel) args.push('--model', options.i18nModel);
      if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
      if (budgetPlan.effective.i18n_total) args.push('--max-budget', String(budgetPlan.effective.i18n_total));
      logProvider(slug, `i18n started: ${i18nSelected.length} locales`);
      const r = await callStage('i18n', args, { progressLabel: `[${slug}] i18n` });
      const combined = (r.stdout || '') + (r.stderr || '');
      const i18nLines = combined.split('\n').filter(Boolean);
      const summaryLine = [...i18nLines].reverse().find((line) => line.startsWith('[i18n] ') && line.includes(' ok;'));
      if (summaryLine) {
        process.stderr.write(`[${slug}] ${summaryLine}\n`);
      } else {
        logProvider(slug, `i18n finished: exit=${r.code}`);
      }
      for (const line of i18nLines.filter((line) => line.includes('[i18n:warn]') || line.includes('unknown locale')).slice(0, 5)) {
        process.stderr.write(`[${slug}] ${line}\n`);
      }
    }
  } else if (!options.i18nArg) {
    process.stderr.write('i18n: no --i18n flag — skipping translation. Pass --i18n all | zh_CN,ja_JP,... | none to control explicitly.\n');
  }

  // ── post.mjs (always, on OK slugs) ──────────────────────────────────────

  if (okSlugs.length > 0) {
    for (const slug of okSlugs) {
      const r = await callStage('post', [
        '--manifest', manifestPath,
        '--slug-dir', protocolDir(outputRoot, slug),
      ]);
      if (r.code !== 0) {
        process.stderr.write(`[post] ${slug} failed; record.import.json may be missing\n`);
        if (r.stderr) process.stderr.write(r.stderr);
      } else {
        logProvider(slug, 'post export done: record.import.json');
      }
    }
  }

  // ── Merge per-slug summary rows + i18n column → summary.tsv ─────────────

  const lines = ['slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n'];
  for (const f of rowFiles) {
    const row = (await readFile(join(summaryRowsDir, f), 'utf8')).replace(/\n+$/, '');
    if (!row) continue;
    const slug = row.split('\t')[0];
    let i18nCol = '-';
    if (i18nSelected.length > 0) {
      const i18nDir = join(protocolDir(outputRoot, slug), '_debug', 'i18n');
      let okCount = 0;
      try {
        const entries = await readdir(i18nDir);
        for (const ent of entries) {
          if (!ent.endsWith('.json')) continue;
          if (ent.endsWith('.envelope.json')) continue;
          okCount += 1;
        }
        i18nCol = `${okCount}/${i18nSelected.length}`;
      } catch {
        i18nCol = `0/${i18nSelected.length}`;
      }
    }
    lines.push(`${row}\t${i18nCol}`);
  }
  await writeFile(summaryFile, lines.join('\n') + '\n');
  for (const row of lines.slice(1)) {
    const slug = row.split('\t')[0];
    const slugDir = protocolDir(outputRoot, slug);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, 'summary.tsv'), `${lines[0]}\n${row}\n`);
  }

  // ── Commit phase ─────────────────────────────────────────────────────────
  await commitOkSlugs(outputRoot, okSlugs, runId);

  let outBrowserFile = null;
  try {
    outBrowserFile = await buildOutBrowser(outputRoot);
  } catch (err) {
    process.stderr.write(`out browser: failed to refresh index.html: ${err.message}\n`);
  }

  // ── Print summary table (plain TSV → padded by computing column widths) ──
  console.log('');
  console.log('=== Summary ===');
  printPadded(lines);
  console.log('');
  console.log(`Review source: ${outputRoot}/<slug>/record.json`);
  console.log(`Import JSON:   ${outputRoot}/<slug>/record.import.json`);
  console.log(`Batch summary: ${summaryFile}`);
  if (outBrowserFile) console.log(`Out browser: ${outBrowserFile}`);

  if (workerFailures.length > 0) {
    throw new Error(`${workerFailures.length} provider worker(s) crashed; see ${join(runMetaDir, '.worker-logs')}`);
  }

  return { outputRoot, runId, runDir: runMetaDir, summaryFile, okSlugs };
}

function printPadded(rows) {
  if (rows.length === 0) return;
  const cols = rows.map((r) => r.split('\t'));
  const widths = [];
  for (const row of cols) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i] || 0, row[i].length);
    }
  }
  for (const row of cols) {
    const padded = row.map((c, i) => c.padEnd(widths[i] || 0, ' '));
    console.log(padded.join('  '));
  }
}
