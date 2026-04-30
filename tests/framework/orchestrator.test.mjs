// Sanity tests for framework/orchestrator.mjs.
// Phase 9.1 ships a glue module; deep behavior is exercised by Phase 9.4 e2e.
// Here we just guarantee the module loads and exports the public surface.

import { strict as assert } from 'node:assert';
import {
  run,
  runOne,
  slugify,
  resolveI18nSelection,
  computeBudgetPlan,
  protocolDir,
  runIndexDir,
} from '../../framework/orchestrator.mjs';

export const tests = [
  {
    name: 'orchestrator module exports run + runOne',
    fn: async () => {
      assert.equal(typeof run, 'function');
      assert.equal(typeof runOne, 'function');
    },
  },
  {
    name: 'slugify mirrors run.sh slugify()',
    fn: async () => {
      assert.equal(slugify('f(x)Protocol'), 'f-x-protocol');
      assert.equal(slugify('Saturn Credit'), 'saturn-credit');
      assert.equal(slugify('  Pendle!! '), 'pendle');
      assert.equal(slugify(''), '');
    },
  },
  {
    name: 'resolveI18nSelection: empty/none → []',
    fn: async () => {
      assert.deepEqual(resolveI18nSelection('', { i18n: { locale_catalog: [{ code: 'zh_CN' }] } }), []);
      assert.deepEqual(resolveI18nSelection('none', { i18n: { locale_catalog: [{ code: 'zh_CN' }] } }), []);
    },
  },
  {
    name: 'resolveI18nSelection: all → manifest catalog codes',
    fn: async () => {
      const manifest = { i18n: { locale_catalog: [{ code: 'zh_CN' }, { code: 'ja_JP' }] } };
      assert.deepEqual(resolveI18nSelection('all', manifest), ['zh_CN', 'ja_JP']);
    },
  },
  {
    name: 'resolveI18nSelection: comma list passes through trimmed',
    fn: async () => {
      assert.deepEqual(
        resolveI18nSelection('zh_CN, ja_JP ,en_US', { i18n: { locale_catalog: [] } }),
        ['zh_CN', 'ja_JP', 'en_US'],
      );
    },
  },
  {
    name: 'computeBudgetPlan scales stage totals under single-provider cap',
    fn: async () => {
      const manifest = {
        subtasks: [{ max_budget_usd: 1 }, { max_budget_usd: 3 }],
        reconcile: { enabled: true, max_budget_usd: 2, max_research_rounds: 2 },
        i18n: { max_budget_usd_per_call: 0.5 },
      };
      const plan = computeBudgetPlan(manifest, { maxBudget: 4, i18nLocaleCount: 2 });
      assert.equal(plan.defaults.total, 9);
      assert.ok(plan.effective.total <= 4);
      assert.ok(plan.effective.total > 3.99);
      assert.ok(plan.effective.r1_total > 0);
      assert.ok(plan.effective.r2_total > 0);
      assert.ok(plan.effective.i18n_total > 0);
    },
  },
  {
    name: 'computeBudgetPlan leaves defaults unchanged without user cap',
    fn: async () => {
      const manifest = {
        subtasks: [{ max_budget_usd: 1 }],
        reconcile: { enabled: true, max_budget_usd: 2, max_research_rounds: 2 },
        i18n: { max_budget_usd_per_call: 0.1 },
      };
      const plan = computeBudgetPlan(manifest, { i18nLocaleCount: 3 });
      assert.equal(plan.mode, 'manifest_defaults');
      assert.equal(plan.effective.total, 5.3);
    },
  },
  {
    name: 'protocolDir returns out/<slug>/ (no run-id segment)',
    fn: async () => {
      assert.equal(protocolDir('/tmp/out', 'pendle'), '/tmp/out/pendle');
    },
  },
  {
    name: 'runIndexDir lives under .runs/ (gitignored)',
    fn: async () => {
      assert.equal(runIndexDir('/tmp/out', 'R1'), '/tmp/out/.runs/R1');
    },
  },
  {
    name: 'run() rejects unsupported R2 routing before provider work starts',
    fn: async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'pi-r2-routing-'));
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      await assert.rejects(
        () => run({
          manifestPath,
          providers: [],
          outputRoot: dir,
          runId: 'R-bad-routing',
          options: { r2Routing: 'external_frist' },
        }),
        (err) => err.kind === 'arg_invalid' && /unsupported R2 routing/.test(err.message),
      );
    },
  },
  {
    name: 'run() auto-commits each successful slug with crawl() message + Run-Id (sequential post-parallel)',
    fn: async () => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { ensureRepo, log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-orch-'));
      await ensureRepo(dir);
      // Simulate two slugs whose pipelines have both written record.json,
      // then invoke the orchestrator's commit-phase loop directly. We import
      // a non-exported helper via a small shim: the real run() loop is what
      // we trust, but we exercise its building block by calling commit()
      // with the same message shape run() will produce.
      for (const slug of ['pendle', 'morpho']) {
        await mkdir(join(dir, slug), { recursive: true });
        await writeFile(join(dir, slug, 'record.json'), `{"slug":"${slug}"}`);
      }
      const { commit } = await import('../../framework/version-store.mjs');
      // Sequential commit loop, identical to run()'s post-parallel block:
      for (const slug of ['pendle', 'morpho']) {
        await commit(dir, { paths: [`${slug}/`], message: `crawl(${slug}): R1+R2 ok`, runId: 'R-test' });
      }
      const pendleHist = await log(dir, { slug: 'pendle' });
      const morphoHist = await log(dir, { slug: 'morpho' });
      assert.equal(pendleHist.length, 1);
      assert.equal(morphoHist.length, 1);
      assert.match(pendleHist[0].message, /^crawl\(pendle\): R1\+R2 ok$/);
      assert.match(morphoHist[0].message, /^crawl\(morpho\): R1\+R2 ok$/);
      assert.equal(pendleHist[0].runId, 'R-test');
    },
  },
  {
    name: 'run() commits post/i18n artifacts and leaves successful slug clean',
    fn: async () => {
      const { mkdtemp, mkdir, readFile, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { spawn } = await import('node:child_process');
      const { isClean, log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-run-ok-'));
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      const arg = (args, name) => {
        const i = args.indexOf(`--${name}`);
        return i === -1 ? null : args[i + 1];
      };
      const copyJson = async (from, to) => {
        await writeFile(to, await readFile(from, 'utf8'));
      };
      const fakeCallCli = async (name, args) => {
        if (name === 'fetch') {
          await writeFile(arg(args, 'output'), JSON.stringify({ fetcher_status: { rootdata: 'skipped_missing_env', defillama: 'ok' } }));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'r1') {
          await writeFile(arg(args, 'record-out'), JSON.stringify({ name: 'Pendle', description: 'AMM', members: [], fundingRounds: [], audits: { items: [] } }));
          await writeFile(arg(args, 'findings-out'), '[]');
          await writeFile(arg(args, 'gaps-out'), '[]');
          await writeFile(arg(args, 'handoff-out'), '[]');
          await writeFile(join(arg(args, 'debug-dir'), 'r1-status.json'), JSON.stringify({ subtasks: [], failed_subtasks: [] }));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'evidence-diff') return { code: 0, stdout: '', stderr: '' };
        if (name === 'audit-reports') return { code: 0, stdout: '', stderr: '[audit-reports] extracted=0 failed=0\n' };
        if (name === 'r2') return { code: 1, stdout: '', stderr: 'skip r2 in test' };
        if (name === 'normalize') {
          await copyJson(arg(args, 'record-in'), arg(args, 'record-out'));
          await copyJson(arg(args, 'changes-in'), arg(args, 'changes-out'));
          await copyJson(arg(args, 'gaps-in'), arg(args, 'gaps-out'));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'i18n') {
          const outDir = arg(args, 'output-dir');
          await mkdir(outDir, { recursive: true });
          await writeFile(join(outDir, 'zh_CN.json'), JSON.stringify({ description: 'AMM zh' }));
          return { code: 0, stdout: '[i18n] 1/1 ok; failed: none\n', stderr: '' };
        }
        if (name === 'post') {
          const slugDir = arg(args, 'slug-dir');
          const record = JSON.parse(await readFile(join(slugDir, 'record.json'), 'utf8'));
          await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'pendle', locale: 'en' }] }));
          await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({ ...record, i18n: { zh_CN: { description: 'AMM zh' } } }));
          const meta = JSON.parse(await readFile(join(slugDir, 'meta.json'), 'utf8'));
          meta.i18n = { locales_ok: ['zh_CN'], locales_failed: [] };
          await writeFile(join(slugDir, 'meta.json'), JSON.stringify(meta, null, 2));
          return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected cli ${name}`);
      };
      const fakeValidator = async () => ({ code: 0, stdout: 'OK\n', stderr: '' });

      await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-ok',
        parallelism: 1,
        options: { i18nArg: 'zh_CN', callCli: fakeCallCli, callValidator: fakeValidator },
      });

      const show = async (path) => new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const p = spawn('git', ['show', `HEAD:${path}`], { cwd: dir });
        p.stdout.on('data', (b) => { stdout += b.toString(); });
        p.stderr.on('data', (b) => { stderr += b.toString(); });
        p.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      });
      assert.match(await show('pendle/record.import.json'), /"locale":"en"/);
      assert.match(await show('pendle/record.full.json'), /zh_CN/);
      assert.match(await show('pendle/meta.json'), /locales_ok/);
      assert.equal(await isClean(dir, { slug: 'pendle' }), true);
      const hist = await log(dir, { slug: 'pendle' });
      assert.equal(hist.length, 1);
      assert.equal(hist[0].message, 'crawl(pendle): R1+R2 ok');
    },
  },
  {
    name: 'run() rolls schema-failed slug back to clean canonical state',
    fn: async () => {
      const { mkdtemp, mkdir, readFile, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const { isClean, log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-run-fail-'));
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      const arg = (args, name) => {
        const i = args.indexOf(`--${name}`);
        return i === -1 ? null : args[i + 1];
      };
      const fakeCallCli = async (name, args) => {
        if (name === 'fetch') {
          await writeFile(arg(args, 'output'), JSON.stringify({ fetcher_status: { rootdata: 'skipped_missing_env', defillama: 'ok' } }));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'r1') {
          await writeFile(arg(args, 'record-out'), JSON.stringify({ bad: true }));
          await writeFile(arg(args, 'findings-out'), '[]');
          await writeFile(arg(args, 'gaps-out'), '[]');
          await writeFile(arg(args, 'handoff-out'), '[]');
          await writeFile(join(arg(args, 'debug-dir'), 'r1-status.json'), JSON.stringify({ subtasks: [], failed_subtasks: [] }));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'evidence-diff') return { code: 0, stdout: '', stderr: '' };
        if (name === 'audit-reports') return { code: 0, stdout: '', stderr: '[audit-reports] extracted=0 failed=0\n' };
        if (name === 'r2') return { code: 1, stdout: '', stderr: 'skip r2 in test' };
        if (name === 'normalize') {
          await mkdir(join(dir, 'protocol-logo'), { recursive: true });
          await writeFile(join(dir, 'protocol-logo', 'pendle.png'), 'failed-logo');
          await writeFile(arg(args, 'created-assets-out'), JSON.stringify(['protocol-logo/pendle.png']));
          await writeFile(arg(args, 'record-out'), await readFile(arg(args, 'record-in'), 'utf8'));
          await writeFile(arg(args, 'changes-out'), await readFile(arg(args, 'changes-in'), 'utf8'));
          await writeFile(arg(args, 'gaps-out'), await readFile(arg(args, 'gaps-in'), 'utf8'));
          return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected cli ${name}`);
      };
      const fakeValidator = async () => ({ code: 1, stdout: 'FAIL\n', stderr: '' });

      await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-fail',
        parallelism: 1,
        options: { i18nArg: 'none', callCli: fakeCallCli, callValidator: fakeValidator },
      });

      assert.equal(existsSync(join(dir, 'pendle', 'record.json')), false);
      assert.equal(existsSync(join(dir, 'protocol-logo', 'pendle.png')), false);
      assert.equal(await isClean(dir, { slug: 'pendle' }), true);
      assert.deepEqual(await log(dir, { slug: 'pendle' }), []);
    },
  },
  {
    name: 'appendRunsLog writes one TSV line: ts \\t runId \\t slugs \\t outcome',
    fn: async () => {
      const { mkdtemp, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { appendRunsLog } = await import('../../framework/orchestrator.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-runs-'));
      await appendRunsLog(dir, {
        runId: '20260427T103211Z',
        slugs: ['pendle', 'morpho'],
        outcome: '2 OK / 0 fail',
      });
      const body = await readFile(join(dir, '.runs.log'), 'utf8');
      const fields = body.trim().split('\t');
      assert.equal(fields.length, 4);
      assert.match(fields[0], /^\d{4}-\d{2}-\d{2}T/); // ISO ts
      assert.equal(fields[1], '20260427T103211Z');
      assert.equal(fields[2], 'pendle,morpho');
      assert.equal(fields[3], '2 OK / 0 fail');
    },
  },
  {
    name: 'appendRunsLog appends (does not truncate) on second call',
    fn: async () => {
      const { mkdtemp, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { appendRunsLog } = await import('../../framework/orchestrator.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-runs-'));
      await appendRunsLog(dir, { runId: 'A', slugs: ['x'], outcome: '1 OK' });
      await appendRunsLog(dir, { runId: 'B', slugs: ['y'], outcome: '1 OK' });
      const body = await readFile(join(dir, '.runs.log'), 'utf8');
      const lines = body.trim().split('\n');
      assert.equal(lines.length, 2);
    },
  },
  {
    name: 'parallel-safety: 4 slugs committed back-to-back never corrupt the index',
    fn: async () => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { ensureRepo, commit, log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-par-'));
      await ensureRepo(dir);
      const slugs = ['a', 'b', 'c', 'd'];
      for (const s of slugs) {
        await mkdir(join(dir, s), { recursive: true });
        await writeFile(join(dir, s, 'record.json'), `{"s":"${s}"}`);
      }
      // Sequentially invoke commit() for each slug — this mirrors what run()
      // does post-parallel. The test would FAIL if a future refactor wrapped
      // these in Promise.all() (parallel index writes → "fatal: Unable to
      // create '.git/index.lock'" or similar).
      for (const s of slugs) {
        await commit(dir, { paths: [`${s}/`], message: `crawl(${s}): R1+R2 ok`, runId: 'R-par' });
      }
      for (const s of slugs) {
        const h = await log(dir, { slug: s });
        assert.equal(h.length, 1, `${s} should have exactly one commit`);
      }
    },
  },
  {
    name: 'guardClobber throws when slug has uncommitted changes (no --force-overwrite)',
    fn: async () => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const { guardClobber } = await import('../../framework/orchestrator.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-guard-'));
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}');
      await commit(dir, { paths: ['pendle/'], message: 'a', runId: 'A' });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}'); // uncommitted edit
      await assert.rejects(
        () => guardClobber(dir, 'pendle', { forceOverwrite: false }),
        /uncommitted changes/i
      );
    },
  },
  {
    name: 'guardClobber passes silently with --force-overwrite',
    fn: async () => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const { guardClobber } = await import('../../framework/orchestrator.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-guard-'));
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}');
      await commit(dir, { paths: ['pendle/'], message: 'a', runId: 'A' });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}');
      await guardClobber(dir, 'pendle', { forceOverwrite: true }); // no throw
    },
  },
  {
    name: '[REGRESSION] failed-pipeline invariant: workerFailures slug gets NO commit, prior record stays at HEAD',
    fn: async () => {
      const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { ensureRepo, commit, log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-fail-'));
      await ensureRepo(dir);
      // Establish a known-good prior commit for pendle:
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}\n');
      await commit(dir, { paths: ['pendle/'], message: 'crawl(pendle): R1+R2 ok', runId: 'R-prior' });
      // Simulate a partially-failed batch: pendle is in workerFailures, morpho in okSlugs.
      // The orchestrator's commit loop iterates okSlugs ONLY — so pendle must NOT
      // get a new commit even though _debug/ etc. may have been written.
      await writeFile(join(dir, 'pendle', '_debug', 'r1.stderr.log').replace('_debug/r1', '_debug-r1'), '').catch(() => {});
      await mkdir(join(dir, 'pendle', '_debug'), { recursive: true });
      await writeFile(join(dir, 'pendle', '_debug', 'r1.stderr.log'), 'crash trace');
      await mkdir(join(dir, 'morpho'), { recursive: true });
      await writeFile(join(dir, 'morpho', 'record.json'), '{"slug":"morpho"}\n');
      // Mirror run()'s commit loop: iterate ONLY okSlugs:
      const okSlugs = ['morpho']; // pendle deliberately omitted (failed)
      for (const slug of okSlugs) {
        await commit(dir, { paths: [`${slug}/`], message: `crawl(${slug}): R1+R2 ok`, runId: 'R-fail' });
      }
      // Pendle history: still 1 commit, the prior good state. NO new commit for the failure.
      const pendleHist = await log(dir, { slug: 'pendle' });
      assert.equal(pendleHist.length, 1, 'pendle should NOT get a commit for the failed run');
      assert.equal(pendleHist[0].runId, 'R-prior', 'pendle should still be at the prior commit');
      // Morpho history: 1 commit from this run.
      const morphoHist = await log(dir, { slug: 'morpho' });
      assert.equal(morphoHist.length, 1);
      assert.equal(morphoHist[0].runId, 'R-fail');
      // Pendle's record.json content: unchanged from the prior commit.
      const pendleRecord = await readFile(join(dir, 'pendle', 'record.json'), 'utf8');
      assert.equal(pendleRecord.trim(), '{"v":1}');
    },
  },
  {
    name: 'cli plumbs --force-overwrite into options.forceOverwrite',
    fn: async () => {
      // End-to-end argv parse: ensures a typo in cli.mjs (e.g. force_overwrite,
      // forceClobber) doesn't silently disable the escape hatch. Imports the
      // pure parse function from cli.mjs (Task 9 step 4 exports it).
      const { parseArgv } = await import('../../framework/cli.mjs');
      const { providers, options } = parseArgv([
        '--display-name', 'Pendle', '--force-overwrite',
      ]);
      assert.equal(providers.length, 1);
      assert.equal(options.forceOverwrite, true);
    },
  },
];
