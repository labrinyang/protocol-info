import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureRepo } from '../../framework/version-store.mjs';

async function makeTempOut() {
  return await mkdtemp(join(tmpdir(), 'pi-vs-'));
}

export const tests = [
  {
    name: 'ensureRepo creates .git, .gitignore, and configures local user',
    fn: async () => {
      const dir = await makeTempOut();
      await ensureRepo(dir);
      assert.ok(existsSync(join(dir, '.git')), '.git not created');
      const gi = await readFile(join(dir, '.gitignore'), 'utf8');
      assert.match(gi, /^_debug\/$/m);
      assert.match(gi, /^\.runs\/$/m);
      assert.match(gi, /^\.runs\.log$/m);
      assert.match(gi, /^index\.html$/m);
    },
  },
  {
    name: 'ensureRepo is idempotent (second call is a no-op)',
    fn: async () => {
      const dir = await makeTempOut();
      await ensureRepo(dir);
      const before = (await stat(join(dir, '.git'))).mtimeMs;
      await new Promise(r => setTimeout(r, 10));
      await ensureRepo(dir);
      const after = (await stat(join(dir, '.git'))).mtimeMs;
      assert.equal(before, after, '.git was re-initialized');
    },
  },
  {
    name: 'gitignore behavior: .runs/, .runs.log, _debug/, index.html are actually ignored',
    fn: async () => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { spawn } = await import('node:child_process');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      // Create files that SHOULD be ignored:
      await mkdir(join(dir, '.runs', 'R1'), { recursive: true });
      await writeFile(join(dir, '.runs', 'R1', 'summary.tsv'), 'x\n');
      await writeFile(join(dir, '.runs.log'), 'x\n');
      await writeFile(join(dir, 'index.html'), '<html/>');
      await mkdir(join(dir, 'pendle', '_debug'), { recursive: true });
      await writeFile(join(dir, 'pendle', '_debug', 'r1.log'), 'x\n');
      // And a tracked file (record.json) to make sure normal artifacts still surface:
      await writeFile(join(dir, 'pendle', 'record.json'), '{}');
      const status = await new Promise((resolve) => {
        let buf = '';
        // -u (--untracked-files=all) is REQUIRED: without it, git rolls
        // untracked directories up to a single entry like "pendle/" instead
        // of listing "pendle/record.json" individually, which would make
        // the record.json assertion below fail spuriously.
        const p = spawn('git', ['status', '--porcelain', '-u'], { cwd: dir });
        p.stdout.on('data', (b) => { buf += b.toString(); });
        p.on('close', () => resolve(buf));
      });
      assert.doesNotMatch(status, /\.runs\//, '.runs/ leaked into status');
      assert.doesNotMatch(status, /\.runs\.log/, '.runs.log leaked');
      assert.doesNotMatch(status, /index\.html/, 'index.html leaked');
      assert.doesNotMatch(status, /_debug/, '_debug/ leaked');
      assert.match(status, /pendle\/record\.json/, 'record.json should be untracked-and-visible');
    },
  },
  {
    name: 'commit() stages paths and returns sha',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"name":"Pendle"}\n');
      const sha = await commit(dir, {
        paths: ['pendle/'],
        message: 'crawl(pendle): R1+R2 ok',
        runId: '20260427T103211Z',
      });
      assert.match(sha, /^[0-9a-f]{7,40}$/, `not a sha: ${sha}`);
    },
  },
  {
    name: 'commit() returns null when nothing is staged',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      const sha = await commit(dir, {
        paths: ['pendle/'],
        message: 'noop',
        runId: '20260427T103211Z',
      });
      assert.equal(sha, null);
    },
  },
  {
    name: 'commit() embeds Run-Id trailer',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { spawn } = await import('node:child_process');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"x":1}');
      await commit(dir, { paths: ['pendle/'], message: 'crawl', runId: 'RID-XYZ' });
      const out = await new Promise((res) => {
        let buf = '';
        const p = spawn('git', ['log', '-1', '--format=%(trailers:key=Run-Id,valueonly)'], { cwd: dir });
        p.stdout.on('data', (b) => { buf += b.toString(); });
        p.on('close', () => res(buf.trim()));
      });
      assert.equal(out, 'RID-XYZ');
    },
  },
];
