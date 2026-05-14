import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
    name: 'i18n rejects unknown locale before stage or post-processing',
    fn: async () => {
      const out = await seedOut();
      const stderr = [];
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'fr'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async () => {
          throw new Error('i18n stage should not run for unknown locale');
        },
        runPostProcessing: async () => {
          throw new Error('post should not run for unknown locale');
        },
        commitAndRebuild: commitOnly,
        stderr: { write: (s) => stderr.push(s) },
      });
      assert.equal(code, 1);
      assert.match(stderr.join(''), /unknown locale\(s\): fr/);
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'i18n preserves existing sidecars, runs missing locales, then commits generated outputs',
    fn: async () => {
      const out = await seedOut();
      const calls = [];
      await mkdir(join(out, 'pendle', '_debug', 'i18n'), { recursive: true });
      await writeFile(join(out, 'pendle', '_debug', 'i18n', 'ja_JP.json'), '{"description":"stale"}\n');
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'zh-cn,ja-jp'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async ({ slugDir, locales }) => {
          calls.push(['i18n', locales]);
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'ja_JP.json')), true);
          await mkdir(join(slugDir, '_debug', 'i18n'), { recursive: true });
          await writeFile(join(slugDir, '_debug', 'i18n', 'zh_CN.json'), '{"description":"zh"}\n');
          return 0;
        },
        runPostProcessing: async ({ slugDir }) => {
          calls.push(['post']);
          const record = JSON.parse(await readFile(join(slugDir, 'record.json'), 'utf8'));
          await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({ ...record, i18n: {
            ja_JP: JSON.parse(await readFile(join(slugDir, '_debug', 'i18n', 'ja_JP.json'), 'utf8')),
            zh_CN: JSON.parse(await readFile(join(slugDir, '_debug', 'i18n', 'zh_CN.json'), 'utf8')),
          } }));
          await writeFile(join(slugDir, 'record.import.json'), '{"records":[]}\n');
          await writeFile(join(slugDir, 'meta.json'), '{"i18n":{"locales_ok":["ja_JP","zh_CN"]}}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        validate: async () => ({ ok: true, errors: [] }),
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.deepEqual(calls, [['i18n', ['zh_CN']], ['post']]);
      assert.match(await readFile(join(out, 'pendle', 'record.full.json'), 'utf8'), /zh_CN/);
      assert.match(await readFile(join(out, 'pendle', 'record.full.json'), 'utf8'), /ja_JP/);
      assert.match(await readFile(join(out, 'pendle', 'record.import.json'), 'utf8'), /records/);
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist.length, 2);
      assert.equal(hist[0].message, 'i18n(pendle): add zh_CN');
      assert.match(await readFile(join(out, 'pendle', 'summary.tsv'), 'utf8'), /\t2\/2\n$/);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'i18n seeds existing translations from record.full.json before supplementing new locales',
    fn: async () => {
      const out = await seedOut();
      await writeFile(join(out, 'pendle', 'record.full.json'), JSON.stringify({
        name: 'Pendle',
        description: 'AMM',
        i18n: { ja_JP: { description: 'ja old' } },
      }) + '\n');
      await commit(out, { paths: ['pendle/record.full.json'], message: 'i18n(pendle): ja_JP', runId: 'R-old-i18n' });
      const calls = [];
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'ja-jp,zh-cn'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async ({ slugDir, locales }) => {
          calls.push(['i18n', locales]);
          assert.deepEqual(locales, ['zh_CN']);
          assert.equal(JSON.parse(await readFile(join(slugDir, '_debug', 'i18n', 'ja_JP.json'), 'utf8')).description, 'ja old');
          await writeFile(join(slugDir, '_debug', 'i18n', 'zh_CN.json'), '{"description":"zh new"}\n');
          return 0;
        },
        runPostProcessing: async ({ slugDir }) => {
          calls.push(['post']);
          const translations = {};
          for (const f of await readdir(join(slugDir, '_debug', 'i18n'))) {
            if (f.endsWith('.json') && !f.endsWith('.envelope.json') && f !== 'failures.log') {
              translations[f.slice(0, -'.json'.length)] = JSON.parse(await readFile(join(slugDir, '_debug', 'i18n', f), 'utf8'));
            }
          }
          await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({ description: 'AMM', i18n: translations }));
          await writeFile(join(slugDir, 'record.import.json'), '{"records":[]}\n');
          await writeFile(join(slugDir, 'meta.json'), '{"i18n":{"locales_ok":["ja_JP","zh_CN"]}}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        validate: async () => ({ ok: true, errors: [] }),
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.deepEqual(calls, [['i18n', ['zh_CN']], ['post']]);
      const full = JSON.parse(await readFile(join(out, 'pendle', 'record.full.json'), 'utf8'));
      assert.deepEqual(Object.keys(full.i18n).sort(), ['ja_JP', 'zh_CN']);
      assert.equal(full.i18n.ja_JP.description, 'ja old');
      assert.equal(full.i18n.zh_CN.description, 'zh new');
    },
  },
  {
    name: 'i18n --force reruns requested locales and removes their old sidecars first',
    fn: async () => {
      const out = await seedOut();
      await mkdir(join(out, 'pendle', '_debug', 'i18n'), { recursive: true });
      await writeFile(join(out, 'pendle', '_debug', 'i18n', 'ja_JP.json'), '{"description":"ja old"}\n');
      const calls = [];
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'ja-jp', '--force'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async ({ slugDir, locales }) => {
          calls.push(['i18n', locales]);
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'ja_JP.json')), false);
          await writeFile(join(slugDir, '_debug', 'i18n', 'ja_JP.json'), '{"description":"ja new"}\n');
          return 0;
        },
        runPostProcessing: async ({ slugDir }) => {
          calls.push(['post']);
          await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({
            description: 'AMM',
            i18n: { ja_JP: JSON.parse(await readFile(join(slugDir, '_debug', 'i18n', 'ja_JP.json'), 'utf8')) },
          }));
          await writeFile(join(slugDir, 'record.import.json'), '{"records":[]}\n');
          await writeFile(join(slugDir, 'meta.json'), '{"i18n":{"locales_ok":["ja_JP"]}}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        validate: async () => ({ ok: true, errors: [] }),
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.deepEqual(calls, [['i18n', ['ja_JP']], ['post']]);
      assert.match(await readFile(join(out, 'pendle', 'record.full.json'), 'utf8'), /ja new/);
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist[0].message, 'i18n(pendle): refresh ja_JP');
    },
  },
  {
    name: 'i18n skips translation stage when requested locales already exist',
    fn: async () => {
      const out = await seedOut();
      await mkdir(join(out, 'pendle', '_debug', 'i18n'), { recursive: true });
      await writeFile(join(out, 'pendle', '_debug', 'i18n', 'zh_CN.json'), '{"description":"zh old"}\n');
      await writeFile(join(out, 'pendle', '_debug', 'i18n', 'failures.log'), 'ja_JP\told failure\n');
      await writeFile(join(out, 'pendle', 'summary.tsv'), 'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\npendle\tSCHEMA_FAIL\t-\t-\t-\tfail\tr1\tok\t0/1\n');
      const calls = [];
      const cmd = (await import('../../../framework/commands/i18n.mjs')).default;
      const code = await cmd(['pendle', '--locales', 'zh-cn'], {
        outputRoot: out,
        manifestPath,
        runI18nStage: async () => {
          throw new Error('translation stage should not run for already translated locale');
        },
        runPostProcessing: async ({ slugDir }) => {
          calls.push(['post']);
          assert.equal(await readFile(join(slugDir, '_debug', 'i18n', 'failures.log'), 'utf8'), '');
          await writeFile(join(slugDir, 'record.full.json'), JSON.stringify({
            description: 'AMM',
            i18n: { zh_CN: JSON.parse(await readFile(join(slugDir, '_debug', 'i18n', 'zh_CN.json'), 'utf8')) },
          }));
          await writeFile(join(slugDir, 'record.import.json'), '{"records":[]}\n');
          await writeFile(join(slugDir, 'meta.json'), '{"i18n":{"locales_ok":["zh_CN"]}}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        validate: async () => ({ ok: true, errors: [] }),
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.deepEqual(calls, [['post']]);
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist[0].message, 'i18n(pendle): refresh exports');
      const summary = await readFile(join(out, 'pendle', 'summary.tsv'), 'utf8');
      assert.match(summary, /pendle\tOK\t-\t-\t-\tpass\tr1\tok\t1\/1\n$/);
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
