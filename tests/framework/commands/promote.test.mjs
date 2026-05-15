import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepo, commit, log } from '../../../framework/version-store.mjs';

const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');

async function seedOut(status = 'draft') {
  const out = await mkdtemp(join(tmpdir(), 'pi-promote-'));
  await ensureRepo(out);
  await mkdir(join(out, 'pendle'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
    slug: 'pendle',
    status,
    description: 'AMM',
  }) + '\n');
  await writeFile(join(out, 'pendle', 'meta.json'), '{"status":"OK"}\n');
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
    name: 'promote validates transition and reuses set write path',
    fn: async () => {
      const out = await seedOut('draft');
      const cmd = (await import('../../../framework/commands/promote.mjs')).default;
      const code = await cmd(['pendle', 'active'], {
        outputRoot: out,
        manifestPath,
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          await writeFile(join(slugDir, 'record.import.json'), '{"data":[]}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.status, 'active');
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist[0].message, 'promote(pendle): draft -> active');
    },
  },
  {
    name: 'promote rejects invalid lifecycle transition',
    fn: async () => {
      const out = await seedOut('active');
      const stderr = [];
      const cmd = (await import('../../../framework/commands/promote.mjs')).default;
      const code = await cmd(['pendle', 'draft'], {
        outputRoot: out,
        manifestPath,
        stderr: { write: (s) => stderr.push(s) },
      });

      assert.equal(code, 1);
      assert.match(stderr.join(''), /invalid target status/);
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
    },
  },
];
