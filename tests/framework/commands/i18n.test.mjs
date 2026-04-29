import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureRepo, commit, isClean, log } from '../../../framework/version-store.mjs';

const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');

async function seedOut() {
  const out = await mkdtemp(join(tmpdir(), 'pi-i18n-cmd-'));
  await ensureRepo(out);
  await mkdir(join(out, 'pendle'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
    name: 'Pendle',
    description: 'AMM',
  }) + '\n');
  await writeFile(join(out, 'pendle', 'meta.json'), '{"status":"OK","i18n":null}\n');
  await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): ok', runId: 'R-prior' });
  return out;
}

async function commitOnly(outputRoot, { slug, paths, message, runId }) {
  return {
    sha: await commit(outputRoot, { paths: paths || [`${slug}/`], message, runId }),
    browserPath: null,
  };
}

export const tests = [
  {
    name: 'i18n exits 1 when record is missing',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-i18n-cmd-'));
      await ensureRepo(out);
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'zh_CN'], {
        outputRoot: out,
        manifestPath,
        stderr: { write: () => {} },
      });
      assert.equal(code, 1);
    },
  },
  {
    name: 'i18n runs stage sidecars then post-processing and commits generated outputs',
    fn: async () => {
      const out = await seedOut();
      const calls = [];
      await mkdir(join(out, 'pendle', '_debug', 'i18n'), { recursive: true });
      await writeFile(join(out, 'pendle', '_debug', 'i18n', 'ja_JP.json'), '{"description":"stale"}\n');
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'zh_CN,ja_JP'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async ({ slugDir, locales }) => {
          calls.push(['i18n', locales]);
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'ja_JP.json')), false);
          await mkdir(join(slugDir, '_debug', 'i18n'), { recursive: true });
          await writeFile(join(slugDir, '_debug', 'i18n', 'zh_CN.json'), '{"description":"zh"}\n');
          return 0;
        },
        runPostProcessing: async ({ slugDir }) => {
          calls.push(['post']);
          const record = JSON.parse(await readFile(join(slugDir, 'record.json'), 'utf8'));
          await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({ ...record, i18n: { zh_CN: { description: 'zh' } } }));
          await writeFile(join(slugDir, 'record.import.json'), '{"records":[]}\n');
          await writeFile(join(slugDir, 'meta.json'), '{"i18n":{"locales_ok":["zh_CN"]}}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        validate: async () => ({ ok: true, errors: [] }),
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.deepEqual(calls, [['i18n', ['zh_CN', 'ja_JP']], ['post']]);
      assert.match(await readFile(join(out, 'pendle', 'record.full.json'), 'utf8'), /zh_CN/);
      assert.match(await readFile(join(out, 'pendle', 'record.import.json'), 'utf8'), /records/);
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist.length, 2);
      assert.equal(hist[0].message, 'i18n(pendle): zh_CN, ja_JP');
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'i18n stage failure leaves no commit',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'zh_CN'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async () => 2,
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        validate: async () => ({ ok: true, errors: [] }),
        stderr: { write: () => {} },
      });
      assert.equal(code, 2);
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'i18n post-processing failure rolls back generated canonical files',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'zh_CN'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async () => 0,
        runPostProcessing: async ({ slugDir }) => {
          await writeFile(join(slugDir, 'record.full.json'), '{"bad":true}\n');
          return 1;
        },
        commitAndRebuild: commitOnly,
        validate: async () => ({ ok: true, errors: [] }),
        stderr: { write: () => {} },
      });
      assert.equal(code, 1);
      assert.equal(existsSync(join(out, 'pendle', 'record.full.json')), false);
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'i18n validation failure runs no stage and leaves record unchanged',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'zh_CN'], {
        outputRoot: out,
        manifestPath,
        validate: async () => ({ ok: false, errors: ['invalid record'] }),
        runI18nStage: async () => {
          throw new Error('i18n stage should not run');
        },
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        stderr: { write: () => {} },
      });
      assert.equal(code, 1);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'AMM');
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
];
