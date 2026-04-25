// framework/orchestrator.mjs — Node-side port of run.sh's run_one() + dispatcher.
//
// Sequences (per provider):
//   fetch.mjs (if ROOTDATA_API_KEY)
//     -> r1.mjs
//     -> validated_overrides patch (inline)
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
import { readFile, writeFile, mkdir, readdir, stat, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './manifest-loader.mjs';
import { runWithLimit } from './parallel-runner.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(FRAMEWORK_DIR);

// ── child_process helpers ───────────────────────────────────────────────────

function runNode(scriptPath, args, opts = {}) {
  return new Promise((resolvePromise) => {
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
    proc.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    proc.on('error', (err) => resolvePromise({ code: 1, stdout, stderr: stderr + err.message }));
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

// Mirror of run.sh slugify(): lowercase, [^a-z0-9]→-, collapse repeats, trim.
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── runOne: full per-provider pipeline ──────────────────────────────────────

export async function runOne({
  manifestPath,
  manifest,
  provider,
  runDir,
  index,
  total,
  options = {},
}) {
  const slug = provider.slug;
  const providerKey = provider.provider || slug;
  const display = provider.displayName;
  const type = provider.type || '';
  const hints = provider.hints || '';
  const rootdataId = provider.rootdataId != null ? String(provider.rootdataId) : '';

  const indexLabel = String(index).padStart(4, '0');
  const summaryRowsDir = join(runDir, '.summary-rows');
  const summaryRowFile = join(summaryRowsDir, `${indexLabel}-${slug}.tsv`);

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

  const slugDir = join(runDir, slug);
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

  const rootdataEnabled = !!process.env.ROOTDATA_API_KEY;

  // ── Phase 1: fetcher (rootdata) ──────────────────────────────────────────

  let apiExit = 1;
  if (rootdataEnabled) {
    const fetchArgs = [
      '--manifest', manifestPath,
      '--slug', slug,
      '--display-name', display,
      '--hints', hints,
      '--output', rootdataPkt,
    ];
    if (rootdataId) fetchArgs.push('--rootdata-id', rootdataId);
    const r = await callCli('fetch', fetchArgs);
    apiExit = r.code;
    if (r.stderr) {
      try {
        await writeFile(join(debugDir, 'rootdata.stderr.log'), r.stderr);
      } catch { /* best effort */ }
    }
  }

  const apiStatus = !rootdataEnabled
    ? 'disabled'
    : (apiExit === 0 ? 'ok' : `exit_${apiExit}`);

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

  const r1Res = await callCli('r1', r1Args);
  const r1Stderr = r1Res.stderr || '';
  try {
    await writeFile(join(debugDir, 'r1.stderr.log'), r1Stderr);
  } catch { /* best effort */ }

  if (r1Res.code !== 0) {
    console.log(`  -> CRAWL_FAIL (exit ${r1Res.code}); see ${join(debugDir, 'r1.stderr.log')}`);
    if (r1Stderr) {
      process.stderr.write('     --- last stderr lines ---\n');
      process.stderr.write(tailLines(r1Stderr, 20).split('\n').map(l => '     ' + l).join('\n') + '\n\n');
    }
    const apiCol = rootdataEnabled ? `exit_${apiExit}` : 'disabled';
    await writeFile(summaryRowFile, `${slug}\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t${apiCol}\n`);
    return { slug, status: 'CRAWL_FAIL' };
  }

  if (!(await fileNonEmpty(recordPath))) {
    console.log(`  -> CRAWL_FAIL (no slice produced by r1.mjs)`);
    if (r1Stderr) {
      process.stderr.write(tailLines(r1Stderr, 20).split('\n').map(l => '     ' + l).join('\n') + '\n');
    }
    await writeFile(summaryRowFile, `${slug}\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t-\n`);
    return { slug, status: 'CRAWL_FAIL' };
  }

  // ── R1 cost from envelope ────────────────────────────────────────────────

  let r1Cost = 0;
  const r1Envelope = await readJsonSafe(join(r1DebugDir, 'metadata.envelope.json'), null);
  if (r1Envelope && typeof r1Envelope.total_cost_usd === 'number') {
    r1Cost = r1Envelope.total_cost_usd;
  }
  let r1Turns = 0;
  if (r1Envelope && typeof r1Envelope.num_turns === 'number') {
    r1Turns = r1Envelope.num_turns;
  }

  let finalSource = 'r1';
  let r2Cost = 0;
  let r2Turns = 0;
  let overridesApplied = '';
  const memberCandidatesFed = 0;
  const fundingSeverity = 'none';

  // ── Phase 3: validated_overrides patch (inline JS instead of jq) ─────────

  if (rootdataEnabled && apiExit === 0 && existsSync(rootdataPkt)) {
    const evidence = await readJsonSafe(rootdataPkt, {});
    const overrides = evidence?.rootdata?.validated_overrides || {};
    const list = [];
    const record = await readJsonSafe(recordPath, null);
    if (record) {
      if (overrides.providerWebsite) {
        record.providerWebsite = overrides.providerWebsite;
        list.push('providerWebsite');
      }
      if (overrides.providerXLink) {
        record.providerXLink = overrides.providerXLink;
        list.push('providerXLink');
      }
      if (list.length > 0) {
        await writeFile(recordPath, JSON.stringify(record, null, 2));
      }
    }
    overridesApplied = list.join(',');
  }

  // ── Phase 3.5: evidence-diff enrichment ──────────────────────────────────

  if (rootdataEnabled && apiExit === 0 && existsSync(rootdataPkt)) {
    const r = await callCli('evidence-diff', [
      '--evidence-in', rootdataPkt,
      '--record-in', recordPath,
      '--evidence-out', rootdataPkt,
    ]);
    if (r.stderr) {
      try {
        await writeFile(join(debugDir, 'evidence-diff.stderr.log'), r.stderr);
      } catch { /* best effort */ }
    }
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
  await mkdir(r2DebugDir, { recursive: true });
  const r2Res = await callCli('r2', r2Args);
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
    try {
      const entries = await readdir(r2DebugDir);
      for (const f of entries) {
        if (!/^reconcile\.round\d+\.envelope\.json$/.test(f)) continue;
        const env = await readJsonSafe(join(r2DebugDir, f), null);
        if (!env) continue;
        if (typeof env.total_cost_usd === 'number') r2Cost += env.total_cost_usd;
        if (typeof env.num_turns === 'number') r2Turns += env.num_turns;
      }
    } catch { /* directory may not exist */ }
  } else {
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

  const normRes = await callCli('normalize', [
    '--manifest', manifestPath,
    '--record-in', recordPath,
    '--evidence', rootdataPkt,
    '--changes-in', changesPath,
    '--gaps-in', gapsPath,
    '--record-out', recordNorm,
    '--changes-out', changesNorm,
    '--gaps-out', gapsNorm,
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
    process.stderr.write(`  -> normalizer failed (exit ${normRes.code}); keeping pre-normalize record\n`);
    for (const p of [recordNorm, changesNorm, gapsNorm]) {
      try { await unlink(p); } catch { /* best effort */ }
    }
  }

  // ── Schema validation ────────────────────────────────────────────────────

  const schemaPath = manifest._abs.full_schema;
  const schemaRes = await callValidator(['--schema', schemaPath, recordPath]);
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

  const meta = {
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
            overrides_applied: overridesApplied
              ? overridesApplied.split(',').filter(Boolean)
              : [],
          }
        : { used: false, status: apiStatus },
    i18n: null,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

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
  runDir,
  parallelism = 1,
  dryRun = false,
  options = {},
}) {
  const manifest = await loadManifest(manifestPath);

  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, '.summary-rows'), { recursive: true });
  await mkdir(join(runDir, '.worker-logs'), { recursive: true });

  // Header for summary.tsv (rewritten at the end with i18n column merge)
  const summaryFile = join(runDir, 'summary.tsv');

  const total = providers.length;
  const effectiveParallelism = dryRun ? 1 : Math.max(1, parallelism | 0);

  const tasks = providers.map((provider, i) => async () => {
    return runOne({
      manifestPath,
      manifest,
      provider,
      runDir,
      index: i + 1,
      total,
      options: { ...options, dryRun },
    });
  });

  if (effectiveParallelism > 1) {
    console.log(`Dispatching ${total} providers with parallelism=${effectiveParallelism}...`);
  }
  await runWithLimit(effectiveParallelism, tasks, { collectErrors: true });

  if (dryRun) {
    return { runDir, ok: providers.length, failed: 0 };
  }

  // ── Collect OK slugs ─────────────────────────────────────────────────────

  const summaryRowsDir = join(runDir, '.summary-rows');
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

  // ── i18n stage ───────────────────────────────────────────────────────────

  const i18nSelected = resolveI18nSelection(options.i18nArg, manifest);
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
        '--record', join(runDir, slug, 'record.json'),
        '--locales', i18nSelected.join(','),
        '--output-dir', join(runDir, slug, '_debug', 'i18n'),
        '--parallel', String(options.i18nParallel ?? 8),
      ];
      if (options.i18nModel) args.push('--model', options.i18nModel);
      const r = await callCli('i18n', args);
      // Mimic run.sh: prefix lines with [<slug>]
      const combined = (r.stdout || '') + (r.stderr || '');
      if (combined) {
        for (const line of combined.split('\n')) {
          if (line) process.stderr.write(`[${slug}] ${line}\n`);
        }
      }
    }
  } else if (!options.i18nArg) {
    process.stderr.write('i18n: no --i18n flag — skipping translation. Pass --i18n all | zh_CN,ja_JP,... | none to control explicitly.\n');
  }

  // ── post.mjs (always, on OK slugs) ──────────────────────────────────────

  if (okSlugs.length > 0) {
    for (const slug of okSlugs) {
      const r = await callCli('post', [
        '--manifest', manifestPath,
        '--slug-dir', join(runDir, slug),
      ]);
      if (r.code !== 0) {
        process.stderr.write(`[post] ${slug} failed; record.import.json may be missing\n`);
        if (r.stderr) process.stderr.write(r.stderr);
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
      const i18nDir = join(runDir, slug, '_debug', 'i18n');
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

  // ── Print summary table (plain TSV → padded by computing column widths) ──
  console.log('');
  console.log('=== Summary ===');
  printPadded(lines);
  console.log('');
  console.log(`Next: review ${runDir}/<slug>/record.json (or record.full.json if i18n). Import via dashboard CRUD.`);

  return { runDir, summaryFile, okSlugs };
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
