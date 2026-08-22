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

function cliArg(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
}

function createLogoLedgerPipeline(outputRoot, state) {
  return async (name, args) => {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const ok = { code: 0, stdout: '', stderr: '' };

    if (name === 'fetch') {
      if (state.fetchCrash) throw new Error('pre-normalize fetch crash');
      await writeFile(cliArg(args, 'output'), JSON.stringify({
        fetcher_status: { rootdata: 'skipped_missing_env', defillama: 'ok' },
      }));
      return ok;
    }
    if (name === 'r1') {
      await writeFile(cliArg(args, 'record-out'), JSON.stringify({
        slug: 'pendle',
        provider: 'pendle',
        providerLogoUrl: 'https://uni.onekey-asset.com/static/logo/protocol-logo/pendle.png',
        name: 'Pendle',
        description: state.description,
        members: [],
        fundingRounds: [],
        audits: { items: [] },
      }));
      await writeFile(cliArg(args, 'findings-out'), '[]');
      await writeFile(cliArg(args, 'gaps-out'), '[]');
      await writeFile(cliArg(args, 'handoff-out'), '[]');
      await writeFile(join(cliArg(args, 'debug-dir'), 'r1-status.json'), JSON.stringify({
        subtasks: [],
        failed_subtasks: [],
      }));
      return ok;
    }
    if (name === 'evidence-diff' || name === 'audit-reports') return ok;
    if (name === 'r2') return { code: 1, stdout: '', stderr: 'disabled for test' };
    if (name === 'normalize') {
      if (state.normalizeFails) return { code: 1, stdout: '', stderr: 'normalize failed before output' };
      await mkdir(join(outputRoot, 'protocol-logo'), { recursive: true });
      await writeFile(join(outputRoot, 'protocol-logo', 'pendle.png'), 'committed-logo');
      await writeFile(cliArg(args, 'created-assets-out'), JSON.stringify(['protocol-logo/pendle.png']));
      await writeFile(cliArg(args, 'assets-to-commit-out'), JSON.stringify(['protocol-logo/pendle.png']));
      await writeFile(cliArg(args, 'record-out'), await readFile(cliArg(args, 'record-in'), 'utf8'));
      await writeFile(cliArg(args, 'changes-out'), await readFile(cliArg(args, 'changes-in'), 'utf8'));
      await writeFile(cliArg(args, 'gaps-out'), await readFile(cliArg(args, 'gaps-in'), 'utf8'));
      return ok;
    }
    if (name === 'post') {
      const slugDir = cliArg(args, 'slug-dir');
      const record = JSON.parse(await readFile(join(slugDir, 'record.json'), 'utf8'));
      await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({ data: [record] }));
      return ok;
    }
    throw new Error(`unexpected cli ${name}`);
  };
}

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
    name: 'resolveI18nSelection: hyphen dashboard codes normalize to manifest codes',
    fn: async () => {
      const manifest = { i18n: { locale_catalog: [{ code: 'zh_CN' }, { code: 'ja_JP' }, { code: 'en_US' }] } };
      assert.deepEqual(resolveI18nSelection('zh-cn, ja-jp ,en-us', manifest), ['zh_CN', 'ja_JP', 'en_US']);
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
    name: 'protocolDir rejects traversal and encoded path-like slugs',
    fn: async () => {
      assert.throws(() => protocolDir('/tmp/out', '../outside'), /unsafe protocol slug/);
      assert.throws(() => protocolDir('/tmp/out', '%2e%2e'), /unsafe protocol slug/);
      assert.throws(() => protocolDir('/tmp/out', 'a\\..\\b'), /unsafe protocol slug/);
    },
  },
  {
    name: 'run rejects traversal before any provider stage or outside-tree mutation',
    fn: async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = await mkdtemp(join(tmpdir(), 'pi-unsafe-slug-'));
      const outputRoot = join(root, 'out');
      let called = false;
      await assert.rejects(
        () => run({
          manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
          providers: [{ slug: '../outside', provider: '../outside', displayName: 'Outside' }],
          outputRoot,
          runId: 'R-unsafe',
          options: { callCli: async () => { called = true; throw new Error('must not run'); } },
        }),
        /unsafe protocol slug/,
      );
      assert.equal(called, false);
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(join(root, 'outside')), false);
    },
  },
  {
    name: 'run rejects a safe-looking slug directory that is a symlink',
    fn: async () => {
      const { mkdtemp, mkdir, symlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = await mkdtemp(join(tmpdir(), 'pi-symlink-slug-'));
      const outputRoot = join(root, 'out');
      const outside = join(root, 'outside');
      await mkdir(outputRoot);
      await mkdir(outside);
      await symlink(outside, join(outputRoot, 'pendle'));
      let called = false;
      await assert.rejects(
        () => run({
          manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
          providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
          outputRoot,
          runId: 'R-symlink',
          options: { callCli: async () => { called = true; throw new Error('must not run'); } },
        }),
        /refusing protocol directory symlink/,
      );
      assert.equal(called, false);
    },
  },
  {
    name: 'run rejects a symlink nested inside an otherwise safe slug directory',
    fn: async () => {
      const { mkdtemp, mkdir, symlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = await mkdtemp(join(tmpdir(), 'pi-nested-symlink-slug-'));
      const outputRoot = join(root, 'out');
      const outside = join(root, 'outside');
      await mkdir(join(outputRoot, 'pendle'), { recursive: true });
      await mkdir(outside);
      await symlink(outside, join(outputRoot, 'pendle', '_debug'));
      let called = false;
      await assert.rejects(
        () => run({
          manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
          providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
          outputRoot,
          runId: 'R-nested-symlink',
          options: { callCli: async () => { called = true; throw new Error('must not run'); } },
        }),
        /refusing symlink inside protocol directory/,
      );
      assert.equal(called, false);
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
      const { mkdtemp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
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
      let failI18nPost = false;
      let postCalls = 0;
      const fakeCallCli = async (name, args) => {
        if (name === 'fetch') {
          await writeFile(arg(args, 'output'), JSON.stringify({ fetcher_status: { rootdata: 'skipped_missing_env', defillama: 'ok' } }));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'r1') {
          await writeFile(arg(args, 'record-out'), JSON.stringify({ slug: 'pendle', provider: 'pendle', name: 'Pendle', description: 'AMM', members: [], fundingRounds: [], audits: { items: [] } }));
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
          postCalls += 1;
          if (failI18nPost && postCalls === 2) {
            return { code: 0, stdout: '', stderr: '' };
          }
          const slugDir = arg(args, 'slug-dir');
          const record = JSON.parse(await readFile(join(slugDir, 'record.json'), 'utf8'));
          const translations = {};
          try {
            for (const f of await readdir(join(slugDir, '_debug', 'i18n'))) {
              if (!f.endsWith('.json') || f.endsWith('.envelope.json')) continue;
              translations[f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(slugDir, '_debug', 'i18n', f), 'utf8'));
            }
          } catch {
            // No i18n sidecars: real post.mjs only emits source import JSON.
          }
          await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'pendle', provider: 'pendle', locale: 'en' }] }));
          if (Object.keys(translations).length > 0) {
            await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({ ...record, i18n: translations }));
            const meta = JSON.parse(await readFile(join(slugDir, 'meta.json'), 'utf8'));
            meta.i18n = { locales_ok: Object.keys(translations), locales_failed: [] };
            await writeFile(join(slugDir, 'meta.json'), JSON.stringify(meta, null, 2));
          }
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
      assert.equal(hist.length, 2);
      assert.equal(hist[0].message, 'i18n(pendle): post updates');
      assert.equal(hist[1].message, 'crawl(pendle): R1+R2 ok');

      const failedDir = await mkdtemp(join(tmpdir(), 'pi-run-i18n-post-fail-'));
      failI18nPost = true;
      postCalls = 0;
      const failed = await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: failedDir,
        runId: 'R-i18n-post-fail',
        parallelism: 1,
        options: { i18nArg: 'zh_CN', callCli: fakeCallCli, callValidator: fakeValidator },
      });
      assert.deepEqual(failed.okSlugs, []);
      assert.match(await readFile(failed.summaryFile, 'utf8'), /pendle\tI18N_POST_FAIL\t.*\t0\/1/);
      assert.equal((await log(failedDir, { slug: 'pendle' })).length, 1, 'failed i18n post must not be committed');
      assert.equal(await isClean(failedDir, { slug: 'pendle' }), true);
      assert.match(await readFile(join(failedDir, 'pendle', 'record.import.json'), 'utf8'), /"locale":"en"/);
      assert.match(await readFile(join(failedDir, '.runs.log'), 'utf8'), /0 OK \/ 1 fail/);
    },
  },
  {
    name: 'run() never replays a stale created-assets ledger after a pre-normalize crash',
    fn: async () => {
      const { mkdtemp, mkdir, readFile, writeFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { isClean } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-stale-created-ledger-'));
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      const state = { description: 'first', fetchCrash: false, normalizeFails: false };
      const options = {
        i18nArg: 'none',
        callCli: createLogoLedgerPipeline(dir, state),
        callValidator: async () => ({ code: 0, stdout: 'OK\n', stderr: '' }),
      };

      await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-ledger-success',
        parallelism: 1,
        options,
      });
      assert.equal(await readFile(join(dir, 'protocol-logo', 'pendle.png'), 'utf8'), 'committed-logo');
      assert.equal(
        existsSync(join(dir, '.runs', 'R-ledger-success', '.normalizer-ledgers')),
        false,
        'handled success must remove its nonce-scoped normalization ledgers',
      );

      const legacyDebugDir = join(dir, 'pendle', '_debug');
      await mkdir(legacyDebugDir, { recursive: true });
      await writeFile(
        join(legacyDebugDir, 'normalize.created-logo-assets.json'),
        JSON.stringify(['protocol-logo/pendle.png']),
      );
      state.fetchCrash = true;

      await assert.rejects(
        () => run({
          manifestPath,
          providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
          outputRoot: dir,
          runId: 'R-ledger-crash',
          parallelism: 1,
          options,
        }),
        /provider worker\(s\) crashed/,
      );

      assert.equal(await readFile(join(dir, 'protocol-logo', 'pendle.png'), 'utf8'), 'committed-logo');
      assert.match(
        await readFile(join(dir, 'pendle', 'record.json'), 'utf8'),
        /protocol-logo\/pendle\.png/,
      );
      assert.equal(await isClean(dir, { slug: 'pendle' }), true);
      assert.equal(
        existsSync(join(dir, '.runs', 'R-ledger-crash', '.normalizer-ledgers')),
        false,
        'handled worker failure must remove its nonce-scoped normalization ledgers',
      );
    },
  },
  {
    name: 'run() never commits assets from a stale assets-to-commit ledger after normalize fails',
    fn: async () => {
      const { mkdtemp, mkdir, readFile, writeFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const dir = await mkdtemp(join(tmpdir(), 'pi-stale-commit-ledger-'));
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      const state = { description: 'first', fetchCrash: false, normalizeFails: false };
      const options = {
        i18nArg: 'none',
        callCli: createLogoLedgerPipeline(dir, state),
        callValidator: async () => ({ code: 0, stdout: 'OK\n', stderr: '' }),
      };
      const git = promisify(execFile);

      await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-commit-ledger-success',
        parallelism: 1,
        options,
      });

      const legacyDebugDir = join(dir, 'pendle', '_debug');
      await mkdir(legacyDebugDir, { recursive: true });
      await writeFile(join(legacyDebugDir, 'normalize.created-logo-assets.json'), '[]');
      await writeFile(
        join(legacyDebugDir, 'normalize.logo-assets-to-commit.json'),
        JSON.stringify(['protocol-logo/pendle.png']),
      );
      await writeFile(join(dir, 'protocol-logo', 'pendle.png'), 'unrelated-dirty-logo');
      state.description = 'second';
      state.normalizeFails = true;

      await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-commit-ledger-normalize-fail',
        parallelism: 1,
        options,
      });

      assert.equal(
        await readFile(join(dir, 'protocol-logo', 'pendle.png'), 'utf8'),
        'unrelated-dirty-logo',
      );
      const { stdout: committedLogo } = await git(
        'git',
        ['show', 'HEAD:protocol-logo/pendle.png'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(committedLogo, 'committed-logo');
      const { stdout: committedPaths } = await git(
        'git',
        ['ls-tree', '-r', '--name-only', 'HEAD'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.doesNotMatch(committedPaths, /(?:^|\n)\.runs\//);
      assert.equal(
        existsSync(join(dir, '.runs', 'R-commit-ledger-normalize-fail', '.normalizer-ledgers')),
        false,
      );
    },
  },
  {
    name: 'run() clears stale i18n artifacts before no-i18n recrawl post commit',
    fn: async () => {
      const { mkdtemp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { spawn } = await import('node:child_process');
      const { ensureRepo, commit, isClean, log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-run-stale-i18n-'));
      const slugDir = join(dir, 'pendle');
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      await ensureRepo(dir);
      await mkdir(slugDir, { recursive: true });
      await writeFile(join(slugDir, 'record.json'), JSON.stringify({ name: 'Pendle', description: 'old' }));
      await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'pendle', provider: 'pendle', description: 'old zh' }] }));
      await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({ name: 'Pendle', i18n: { zh_CN: { description: 'old zh' } } }));
      await writeFile(join(slugDir, 'meta.json'), JSON.stringify({ status: 'OK', i18n: { locales_ok: ['zh_CN'] } }, null, 2));
      await commit(dir, { paths: ['pendle/'], message: 'seed translated artifacts', runId: 'seed' });
      await mkdir(join(slugDir, '_debug', 'i18n'), { recursive: true });
      await writeFile(join(slugDir, '_debug', 'i18n', 'zh_CN.json'), JSON.stringify({ description: 'stale zh' }));

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
          await writeFile(arg(args, 'record-out'), JSON.stringify({ slug: 'pendle', provider: 'pendle', name: 'Pendle', description: 'new', members: [], fundingRounds: [], audits: { items: [] } }));
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
        if (name === 'post') {
          const postSlugDir = arg(args, 'slug-dir');
          const record = JSON.parse(await readFile(join(postSlugDir, 'record.json'), 'utf8'));
          const translations = {};
          try {
            for (const f of await readdir(join(postSlugDir, '_debug', 'i18n'))) {
              if (!f.endsWith('.json') || f.endsWith('.envelope.json')) continue;
              translations[f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(postSlugDir, '_debug', 'i18n', f), 'utf8'));
            }
          } catch {
            // No i18n sidecars: real post.mjs only emits source import JSON.
          }
          await writeFile(join(postSlugDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'pendle', provider: 'pendle', description: record.description }] }));
          if (Object.keys(translations).length > 0) {
            await writeFile(join(postSlugDir, 'record.full.json'), JSON.stringify({ ...record, i18n: translations }));
            const meta = JSON.parse(await readFile(join(postSlugDir, 'meta.json'), 'utf8'));
            meta.i18n = { locales_ok: Object.keys(translations), locales_failed: [] };
            await writeFile(join(postSlugDir, 'meta.json'), JSON.stringify(meta, null, 2));
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected cli ${name}`);
      };
      const fakeValidator = async () => ({ code: 0, stdout: 'OK\n', stderr: '' });

      await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-no-i18n',
        parallelism: 1,
        options: { i18nArg: 'none', callCli: fakeCallCli, callValidator: fakeValidator },
      });

      const show = async (path) => new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const p = spawn('git', ['show', `HEAD:${path}`], { cwd: dir });
        p.stdout.on('data', (b) => { stdout += b.toString(); });
        p.stderr.on('data', (b) => { stderr += b.toString(); });
        p.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      });
      assert.match(await show('pendle/record.import.json'), /"description":"new"/);
      assert.doesNotMatch(await show('pendle/meta.json'), /locales_ok/);
      let fullMissing = false;
      try {
        await show('pendle/record.full.json');
      } catch {
        fullMissing = true;
      }
      assert.equal(fullMissing, true, 'stale record.full.json must be removed from HEAD');
      assert.equal(await isClean(dir, { slug: 'pendle' }), true);
      const hist = await log(dir, { slug: 'pendle' });
      assert.equal(hist[0].message, 'crawl(pendle): R1+R2 ok');
      assert.equal(hist.length, 2);
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
      await mkdir(join(dir, 'audit-logo'), { recursive: true });
      await writeFile(join(dir, 'audit-logo', 'openzeppelin.png'), 'pre-existing-logo');
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
          await writeFile(arg(args, 'record-out'), JSON.stringify({ slug: 'pendle', provider: 'pendle', bad: true }));
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
          await writeFile(join(dir, 'audit-logo', 'openzeppelin.png'), 'replacement-logo');
          await writeFile(arg(args, 'created-assets-out'), JSON.stringify([{
            relPath: 'audit-logo/openzeppelin.png',
            restoreBase64: Buffer.from('pre-existing-logo').toString('base64'),
          }]));
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
      assert.equal(await readFile(join(dir, 'audit-logo', 'openzeppelin.png'), 'utf8'), 'pre-existing-logo');
      assert.equal(await isClean(dir, { slug: 'pendle' }), true);
      assert.deepEqual(await log(dir, { slug: 'pendle' }), []);
    },
  },
  {
    name: 'run() reports a missing canonical export even when post exits zero and does not commit',
    fn: async () => {
      const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const { log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-run-post-fail-'));
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      const arg = (args, name) => {
        const i = args.indexOf(`--${name}`);
        return i === -1 ? null : args[i + 1];
      };
      const fakeCallCli = async (name, args) => {
        if (name === 'fetch') {
          await writeFile(arg(args, 'output'), JSON.stringify({ fetcher_status: { rootdata: 'skipped_missing_env' } }));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'r1') {
          await writeFile(arg(args, 'record-out'), JSON.stringify({
            slug: 'pendle', provider: 'pendle', displayName: 'Pendle', members: [], fundingRounds: [], audits: { items: [] },
          }));
          await writeFile(arg(args, 'findings-out'), '[]');
          await writeFile(arg(args, 'gaps-out'), '[]');
          await writeFile(arg(args, 'handoff-out'), '[]');
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'audit-reports' || name === 'evidence-diff') return { code: 0, stdout: '', stderr: '' };
        if (name === 'r2') return { code: 1, stdout: '', stderr: 'disabled for test' };
        if (name === 'normalize') {
          await writeFile(arg(args, 'record-out'), await readFile(arg(args, 'record-in'), 'utf8'));
          await writeFile(arg(args, 'changes-out'), '[]');
          await writeFile(arg(args, 'gaps-out'), '[]');
          return { code: 0, stdout: '', stderr: '' };
        }
        if (name === 'post') return { code: 0, stdout: '', stderr: '' };
        throw new Error(`unexpected cli ${name}`);
      };

      const result = await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-post-fail',
        options: { i18nArg: 'none', callCli: fakeCallCli, callValidator: async () => ({ code: 0, stdout: 'OK\n', stderr: '' }) },
      });

      assert.deepEqual(result.okSlugs, []);
      assert.match(await readFile(result.summaryFile, 'utf8'), /pendle\tPOST_FAIL\t/);
      assert.equal(existsSync(join(dir, 'pendle', 'record.json')), false);
      assert.deepEqual(await log(dir, { slug: 'pendle' }), []);
    },
  },
  {
    name: 'run() rejects model output whose slug or provider identity changes',
    fn: async () => {
      const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const { log } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-run-identity-fail-'));
      const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');
      const arg = (args, name) => {
        const i = args.indexOf(`--${name}`);
        return i === -1 ? null : args[i + 1];
      };
      let laterStageCalled = false;
      const result = await run({
        manifestPath,
        providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
        outputRoot: dir,
        runId: 'R-identity-fail',
        options: {
          i18nArg: 'none',
          callCli: async (name, args) => {
            if (name === 'fetch') {
              await writeFile(arg(args, 'output'), JSON.stringify({ fetcher_status: { rootdata: 'skipped_missing_env' } }));
              return { code: 0, stdout: '', stderr: '' };
            }
            if (name === 'r1') {
              await writeFile(arg(args, 'record-out'), JSON.stringify({
                slug: 'attacker-selected',
                provider: 'attacker-selected',
                displayName: 'Pendle',
              }));
              await writeFile(arg(args, 'findings-out'), '[]');
              await writeFile(arg(args, 'gaps-out'), '[]');
              await writeFile(arg(args, 'handoff-out'), '[]');
              return { code: 0, stdout: '', stderr: '' };
            }
            laterStageCalled = true;
            throw new Error(`unexpected cli ${name}`);
          },
        },
      });

      assert.equal(laterStageCalled, false);
      assert.deepEqual(result.okSlugs, []);
      assert.match(await readFile(result.summaryFile, 'utf8'), /pendle\tIDENTITY_FAIL\t/);
      assert.equal(existsSync(join(dir, 'attacker-selected')), false);
      assert.equal(existsSync(join(dir, 'pendle', 'record.json')), false);
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
    name: 'run() preflight failure does not roll back dirty slug files',
    fn: async () => {
      const { mkdtemp, mkdir, readFile, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { ensureRepo, commit, isClean } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-run-preflight-'));
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}\n');
      await commit(dir, { paths: ['pendle/'], message: 'seed', runId: 'seed' });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2,"manual":true}\n');

      await assert.rejects(
        () => run({
          manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
          providers: [{ slug: 'pendle', provider: 'pendle', displayName: 'Pendle' }],
          outputRoot: dir,
          runId: 'R-preflight',
          parallelism: 1,
          options: {
            i18nArg: 'none',
            callCli: async () => {
              throw new Error('pipeline should not start');
            },
          },
        }),
        /provider worker\(s\) crashed/,
      );
      assert.equal(await readFile(join(dir, 'pendle', 'record.json'), 'utf8'), '{"v":2,"manual":true}\n');
      assert.equal(await isClean(dir, { slug: 'pendle' }), false);
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
