import { strict as assert } from 'node:assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureRepo } from '../../framework/version-store.mjs';

async function makeTempOut() {
  return await mkdtemp(join(tmpdir(), 'pi-vs-'));
}

async function gitStdout(cwd, args) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const p = spawn('git', args, { cwd });
    p.stdout.on('data', (b) => { stdout += b.toString(); });
    p.stderr.on('data', (b) => { stderr += b.toString(); });
    p.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr));
    });
  });
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
      assert.match(gi, /^summary\.tsv$/m);
      const { spawn } = await import('node:child_process');
      const signing = await new Promise((resolve) => {
        let stdout = '';
        const p = spawn('git', ['config', '--get', 'commit.gpgsign'], { cwd: dir });
        p.stdout.on('data', (b) => { stdout += b.toString(); });
        p.on('close', () => resolve(stdout.trim()));
      });
      assert.equal(signing, 'false');
    },
  },
  {
    name: 'ensureRepo is idempotent (second call preserves repo and gitignore)',
    fn: async () => {
      const dir = await makeTempOut();
      await ensureRepo(dir);
      const before = await readFile(join(dir, '.gitignore'), 'utf8');
      await ensureRepo(dir);
      const after = await readFile(join(dir, '.gitignore'), 'utf8');
      assert.equal(existsSync(join(dir, '.git')), true);
      assert.equal(after, before, '.gitignore should not duplicate baseline patterns');
    },
  },
  {
    name: 'gitignore behavior: .runs/, .runs.log, _debug/, index.html, summary.tsv are actually ignored',
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
      await writeFile(join(dir, 'pendle', 'summary.tsv'), 'x\n');
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
      assert.doesNotMatch(status, /summary\.tsv/, 'summary.tsv leaked');
      assert.doesNotMatch(status, /_debug/, '_debug/ leaked');
      assert.match(status, /pendle\/record\.json/, 'record.json should be untracked-and-visible');
    },
  },
  {
    name: 'ensureRepo updates an existing out repo gitignore with new baseline patterns',
    fn: async () => {
      const { writeFile } = await import('node:fs/promises');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await writeFile(join(dir, '.gitignore'), '_debug/\n');
      await ensureRepo(dir);
      const gi = await readFile(join(dir, '.gitignore'), 'utf8');
      assert.match(gi, /^summary\.tsv$/m);
      assert.match(gi, /^\.runs\/$/m);
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
  {
    name: 'commit() commits only requested paths and leaves unrelated staged changes staged',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { spawn } = await import('node:child_process');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await mkdir(join(dir, 'morpho'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}\n');
      await writeFile(join(dir, 'morpho', 'record.json'), '{"v":1}\n');
      await commit(dir, { paths: ['pendle/', 'morpho/'], message: 'seed', runId: 'R0' });

      await writeFile(join(dir, 'morpho', 'record.json'), '{"v":2}\n');
      await new Promise((resolve, reject) => {
        const p = spawn('git', ['add', '--', 'morpho/record.json'], { cwd: dir });
        p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git add exited ${code}`)));
      });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}\n');
      await commit(dir, { paths: ['pendle/'], message: 'set(pendle)', runId: 'R1' });

      const committedFiles = await gitStdout(dir, ['show', '--name-only', '--format=', 'HEAD']);
      assert.match(committedFiles, /pendle\/record\.json/);
      assert.doesNotMatch(committedFiles, /morpho\/record\.json/);
      const staged = await gitStdout(dir, ['diff', '--cached', '--name-only']);
      assert.equal(staged.trim(), 'morpho/record.json');
    },
  },
  {
    name: 'log() returns commits scoped to slug, newest first',
    fn: async () => {
      const { ensureRepo, commit, log } = await import('../../framework/version-store.mjs');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await mkdir(join(dir, 'morpho'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}');
      await commit(dir, { paths: ['pendle/'], message: 'crawl(pendle)', runId: 'R1' });
      await writeFile(join(dir, 'morpho', 'record.json'), '{"v":1}');
      await commit(dir, { paths: ['morpho/'], message: 'crawl(morpho)', runId: 'R2' });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}');
      await commit(dir, { paths: ['pendle/'], message: 'set(pendle) v', runId: 'R3' });

      const entries = await log(dir, { slug: 'pendle', limit: 10 });
      assert.equal(entries.length, 2);
      assert.equal(entries[0].message, 'set(pendle) v');
      assert.equal(entries[1].message, 'crawl(pendle)');
      assert.equal(entries[0].runId, 'R3');
      assert.equal(entries[1].runId, 'R1');
      assert.match(entries[0].sha, /^[0-9a-f]{7,40}$/);
      assert.ok(entries[0].ts);
    },
  },
  {
    name: 'log() returns [] on a fresh repo with no commits',
    fn: async () => {
      const { ensureRepo, log } = await import('../../framework/version-store.mjs');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      const entries = await log(dir, { slug: 'pendle' });
      assert.deepEqual(entries, []);
    },
  },
  {
    name: 'diff() returns unified diff between two commits',
    fn: async () => {
      const { ensureRepo, commit, diff } = await import('../../framework/version-store.mjs');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}\n');
      const sha1 = await commit(dir, { paths: ['pendle/'], message: 'a', runId: 'A' });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}\n');
      const sha2 = await commit(dir, { paths: ['pendle/'], message: 'b', runId: 'B' });
      const out = await diff(dir, { slug: 'pendle', fromSha: sha1, toSha: sha2 });
      assert.match(out, /-{"v":1}/);
      assert.match(out, /\+{"v":2}/);
    },
  },
  {
    name: 'restore() reverts files in slug to a previous sha',
    fn: async () => {
      const { ensureRepo, commit, restore } = await import('../../framework/version-store.mjs');
      const { writeFile, mkdir, readFile } = await import('node:fs/promises');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}\n');
      const sha1 = await commit(dir, { paths: ['pendle/'], message: 'a', runId: 'A' });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}\n');
      await writeFile(join(dir, 'pendle', 'record.full.json'), '{"v":2,"i18n":{}}\n');
      await commit(dir, { paths: ['pendle/'], message: 'b', runId: 'B' });
      await restore(dir, { slug: 'pendle', sha: sha1 });
      const after = await readFile(join(dir, 'pendle', 'record.json'), 'utf8');
      assert.equal(after.trim(), '{"v":1}');
      assert.equal(existsSync(join(dir, 'pendle', 'record.full.json')), false);
    },
  },
  {
    name: 'isClean() returns true when slug has no uncommitted changes',
    fn: async () => {
      const { ensureRepo, commit, isClean } = await import('../../framework/version-store.mjs');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}');
      await commit(dir, { paths: ['pendle/'], message: 'a', runId: 'A' });
      assert.equal(await isClean(dir, { slug: 'pendle' }), true);
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}');
      assert.equal(await isClean(dir, { slug: 'pendle' }), false);
    },
  },
  {
    name: 'resetSlugToHead restores tracked files and removes untracked canonical artifacts but keeps ignored debug',
    fn: async () => {
      const { ensureRepo, commit, resetSlugToHead, isClean } = await import('../../framework/version-store.mjs');
      const { writeFile, mkdir, readFile } = await import('node:fs/promises');
      const dir = await makeTempOut();
      await ensureRepo(dir);
      await mkdir(join(dir, 'pendle', '_debug'), { recursive: true });
      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}\n');
      await commit(dir, { paths: ['pendle/'], message: 'a', runId: 'A' });

      await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}\n');
      await writeFile(join(dir, 'pendle', 'meta.json'), '{"status":"SCHEMA_FAIL"}\n');
      await writeFile(join(dir, 'pendle', '_debug', 'schema.stderr.log'), 'bad');
      await resetSlugToHead(dir, { slug: 'pendle' });

      const record = await readFile(join(dir, 'pendle', 'record.json'), 'utf8');
      assert.equal(record.trim(), '{"v":1}');
      assert.equal(existsSync(join(dir, 'pendle', 'meta.json')), false);
      assert.equal(existsSync(join(dir, 'pendle', '_debug', 'schema.stderr.log')), true);
      assert.equal(await isClean(dir, { slug: 'pendle' }), true);
    },
  },
];
