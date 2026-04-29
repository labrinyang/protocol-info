import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepo, commit, isClean, log } from '../../../framework/version-store.mjs';

async function seedOut() {
  const out = await mkdtemp(join(tmpdir(), 'pi-restore-cmd-'));
  await ensureRepo(out);
  await mkdir(join(out, 'pendle'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), '{"name":"V1"}\n');
  await writeFile(join(out, 'pendle', 'findings.json'), '[]\n');
  await writeFile(join(out, 'pendle', 'changes.json'), '[]\n');
  await writeFile(join(out, 'pendle', 'gaps.json'), '[]\n');
  const sha1 = await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): v1', runId: 'R1' });
  await writeFile(join(out, 'pendle', 'record.json'), '{"name":"V2"}\n');
  await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): v2', runId: 'R2' });
  return { out, sha1 };
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
    name: 'restore checks out a prior commit, validates, post-processes, and commits',
    fn: async () => {
      const { out, sha1 } = await seedOut();
      const cmd = (await import('../../../framework/commands/restore.mjs')).default;
      const code = await cmd(['pendle', sha1], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.name, 'V1');
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist.length, 3);
      assert.match(hist[0].message, /^restore\(pendle\) /);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'restore validation failure rolls back file contents and git status',
    fn: async () => {
      const { out, sha1 } = await seedOut();
      const cmd = (await import('../../../framework/commands/restore.mjs')).default;
      const code = await cmd(['pendle', sha1], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        validate: async () => ({ ok: false, errors: ['schema tightened'] }),
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 1);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.name, 'V2');
      assert.equal((await log(out, { slug: 'pendle' })).length, 2);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'restore post-processing failure rolls back checkout',
    fn: async () => {
      const { out, sha1 } = await seedOut();
      const cmd = (await import('../../../framework/commands/restore.mjs')).default;
      const code = await cmd(['pendle', sha1], {
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
      assert.equal(record.name, 'V2');
      assert.equal((await log(out, { slug: 'pendle' })).length, 2);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
];
