import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { ensureRepo, commit, isClean, log } from '../../framework/version-store.mjs';
import { preflightWritableSlug, rollbackSlug, commitAndRebuild } from '../../framework/slug-transaction.mjs';

async function seedOut() {
  const out = await mkdtemp(join(tmpdir(), 'pi-tx-'));
  await ensureRepo(out);
  await mkdir(join(out, 'pendle', '_debug'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), '{"v":1}\n');
  await commit(out, { paths: ['pendle/'], message: 'seed', runId: 'seed' });
  return out;
}

function gitShow(cwd, path) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('git', ['show', `HEAD:${path}`], { cwd });
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

export const tests = [
  {
    name: 'preflightWritableSlug rejects dirty canonical slug',
    fn: async () => {
      const out = await seedOut();
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      await assert.rejects(
        () => preflightWritableSlug(out, 'pendle'),
        /uncommitted changes/
      );
    },
  },
  {
    name: 'preflightWritableSlug allows dirty slug with forceOverwrite',
    fn: async () => {
      const out = await seedOut();
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      await preflightWritableSlug(out, 'pendle', { forceOverwrite: true });
    },
  },
  {
    name: 'rollbackSlug restores HEAD and removes untracked canonical artifacts while preserving debug',
    fn: async () => {
      const out = await seedOut();
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      await writeFile(join(out, 'pendle', 'meta.json'), '{"bad":true}\n');
      await writeFile(join(out, 'pendle', '_debug', 'failure.log'), 'debug');
      await rollbackSlug(out, 'pendle');

      assert.equal((await readFile(join(out, 'pendle', 'record.json'), 'utf8')).trim(), '{"v":1}');
      assert.equal(existsSync(join(out, 'pendle', 'meta.json')), false);
      assert.equal(existsSync(join(out, 'pendle', '_debug', 'failure.log')), true);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'commitAndRebuild commits one logical slug change without rebuilding static browser by default',
    fn: async () => {
      const out = await seedOut();
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      const result = await commitAndRebuild(
        out,
        { slug: 'pendle', message: 'set(pendle) v', runId: 'R1' },
      );
      assert.match(result.sha, /^[0-9a-f]{7,40}$/);
      assert.equal(result.browserPath, null);
      assert.equal(existsSync(join(out, 'index.html')), false);
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist[0].message, 'set(pendle) v');
      assert.equal(hist[0].runId, 'R1');
    },
  },
  {
    name: 'commitAndRebuild still supports an injected rebuild hook',
    fn: async () => {
      const out = await seedOut();
      let rebuilt = false;
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      const result = await commitAndRebuild(
        out,
        { slug: 'pendle', message: 'set(pendle) v', runId: 'R1' },
        { rebuild: async () => { rebuilt = true; return join(out, 'index.html'); } },
      );
      assert.match(result.sha, /^[0-9a-f]{7,40}$/);
      assert.equal(rebuilt, true);
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist[0].message, 'set(pendle) v');
      assert.equal(hist[0].runId, 'R1');
    },
  },
  {
    name: 'commitAndRebuild includes explicit logo asset files',
    fn: async () => {
      const out = await seedOut();
      await mkdir(join(out, 'protocol-logo'), { recursive: true });
      await writeFile(join(out, 'protocol-logo', 'pendle.png'), 'logo-bytes');
      await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
        providerLogoUrl: 'https://uni.onekey-asset.com/static/logo/protocol-logo/pendle.png',
      }) + '\n');

      await commitAndRebuild(
        out,
        {
          slug: 'pendle',
          extraPaths: ['protocol-logo/pendle.png'],
          message: 'set(pendle) providerLogoUrl',
          runId: 'R-logo',
        },
        { rebuild: async () => null },
      );

      assert.equal(await gitShow(out, 'protocol-logo/pendle.png'), 'logo-bytes');
    },
  },
  {
    name: 'commitAndRebuild leaves referenced logo assets alone unless explicit',
    fn: async () => {
      const out = await seedOut();
      await mkdir(join(out, 'protocol-logo'), { recursive: true });
      await writeFile(join(out, 'protocol-logo', 'pendle.png'), 'old-logo');
      await commit(out, { paths: ['protocol-logo/pendle.png'], message: 'seed logo', runId: 'logo' });

      await writeFile(join(out, 'protocol-logo', 'pendle.png'), 'new-logo');
      await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
        providerLogoUrl: 'https://uni.onekey-asset.com/static/logo/protocol-logo/pendle.png',
      }) + '\n');

      await commitAndRebuild(
        out,
        { slug: 'pendle', message: 'set(pendle) providerLogoUrl', runId: 'R-logo' },
        { rebuild: async () => null },
      );

      assert.equal(await gitShow(out, 'protocol-logo/pendle.png'), 'old-logo');
    },
  },
];
