import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureRepo, commit, isClean, log } from '../../../framework/version-store.mjs';

async function seedOut() {
  const out = await mkdtemp(join(tmpdir(), 'pi-set-'));
  await ensureRepo(out);
  await mkdir(join(out, 'pendle'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
    name: 'Pendle',
    description: 'old',
    members: [],
  }) + '\n');
  await writeFile(join(out, 'pendle', 'findings.json'), '[]\n');
  await writeFile(join(out, 'pendle', 'changes.json'), '[]\n');
  await writeFile(join(out, 'pendle', 'gaps.json'), '[]\n');
  await writeFile(join(out, 'pendle', 'meta.json'), '{"status":"OK"}\n');
  await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): ok', runId: 'R-prior' });
  return out;
}

async function commitOnly(outputRoot, { slug, message, runId }) {
  return {
    sha: await commit(outputRoot, { paths: [`${slug}/`], message, runId }),
    browserPath: null,
  };
}

async function normalizeNoop(envelope) {
  return envelope;
}

export const tests = [
  {
    name: 'set updates one path, runs post-processing, and commits',
    fn: async () => {
      const out = await seedOut();
      let postCalled = false;
      const cmd = (await import('../../../framework/commands/set.mjs')).default;
      const code = await cmd(['pendle', 'description', '"new"'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          postCalled = true;
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.equal(postCalled, true);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'new');
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist.length, 2);
      assert.equal(hist[0].message, 'set(pendle) description');
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'set validation failure leaves file and history unchanged',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/set.mjs')).default;
      const code = await cmd(['pendle', 'description', '42'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        validate: async () => ({ ok: false, errors: ['$.description: expected string'] }),
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 1);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'old');
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'set post-processing failure rolls back written canonical files',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/set.mjs')).default;
      const code = await cmd(['pendle', 'description', '"new"'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async () => 1,
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 1);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'old');
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'set invalidates stale i18n sidecars and full/meta artifacts before post-processing',
    fn: async () => {
      const out = await seedOut();
      await mkdir(join(out, 'pendle', '_debug', 'i18n'), { recursive: true });
      await writeFile(join(out, 'pendle', '_debug', 'i18n', 'zh_CN.json'), '{"description":"old zh"}\n');
      await writeFile(join(out, 'pendle', 'record.full.json'), '{"description":"old","i18n":{"zh_CN":{"description":"old zh"}}}\n');
      await writeFile(join(out, 'pendle', 'meta.json'), '{"status":"OK","i18n":{"locales_ok":["zh_CN"]}}\n');
      await commit(out, { paths: ['pendle/'], message: 'i18n(pendle): zh_CN', runId: 'R-i18n' });

      const cmd = (await import('../../../framework/commands/set.mjs')).default;
      const code = await cmd(['pendle', 'description', '"new"'], {
        outputRoot: out,
        manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'zh_CN.json')), false);
          assert.equal(existsSync(join(slugDir, 'record.full.json')), false);
          const meta = JSON.parse(await readFile(join(slugDir, 'meta.json'), 'utf8'));
          assert.equal(meta.i18n, undefined);
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.equal(existsSync(join(out, 'pendle', 'record.full.json')), false);
      const meta = JSON.parse(await readFile(join(out, 'pendle', 'meta.json'), 'utf8'));
      assert.equal(meta.i18n, undefined);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'set validation failure removes logo assets created by normalizers',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-set-logo-'));
      await ensureRepo(out);
      await mkdir(join(out, 'pendle'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
        slug: 'pendle',
        provider: 'pendle',
        providerLogoUrl: null,
        displayName: 'Pendle',
        members: [],
        audits: { items: [] },
      }) + '\n');
      await writeFile(join(out, 'pendle', 'findings.json'), '[]\n');
      await writeFile(join(out, 'pendle', 'changes.json'), '[]\n');
      await writeFile(join(out, 'pendle', 'gaps.json'), '[]\n');
      await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): ok', runId: 'R-prior' });

      const cmd = (await import('../../../framework/commands/set.mjs')).default;
      const code = await cmd(['pendle', 'providerLogoUrl', '"https://example.com/pendle.png"'], {
        outputRoot: out,
        manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
        normalizerContext: {
          fetchImage: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => Buffer.from('logo'),
          }),
        },
        validate: async () => ({ ok: false, errors: ['schema failure after normalize'] }),
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        stderr: { write: () => {} },
      });

      assert.equal(code, 1);
      assert.equal(existsSync(join(out, 'protocol-logo', 'pendle.png')), false);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.providerLogoUrl, null);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'set passes newly rehosted logo asset paths to commit',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-set-logo-commit-'));
      await ensureRepo(out);
      await mkdir(join(out, 'pendle'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
        slug: 'pendle',
        provider: 'pendle',
        providerLogoUrl: null,
        displayName: 'Pendle',
        members: [],
        audits: { items: [] },
      }) + '\n');
      await writeFile(join(out, 'pendle', 'findings.json'), '[]\n');
      await writeFile(join(out, 'pendle', 'changes.json'), '[]\n');
      await writeFile(join(out, 'pendle', 'gaps.json'), '[]\n');
      await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): ok', runId: 'R-prior' });

      let commitOpts = null;
      const cmd = (await import('../../../framework/commands/set.mjs')).default;
      const code = await cmd(['pendle', 'providerLogoUrl', '"https://example.com/pendle.png"'], {
        outputRoot: out,
        manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
        normalizerContext: {
          fetchImage: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => Buffer.from('logo'),
          }),
        },
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: async (outputRoot, opts) => {
          commitOpts = opts;
          return { sha: null, browserPath: null };
        },
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      assert.deepEqual(commitOpts.extraPaths, ['protocol-logo/pendle.png']);
      assert.equal(existsSync(join(out, 'protocol-logo', 'pendle.png')), true);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.providerLogoUrl, 'https://uni.onekey-asset.com/static/logo/protocol-logo/pendle.png');
    },
  },
];
