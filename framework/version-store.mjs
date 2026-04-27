// framework/version-store.mjs — git wrapper for out/.git history layer.
//
// Pure shell-out via child_process.spawn. No libgit2, no isomorphic-git —
// `git` on PATH is already required for the plugin (installed via Claude
// Code's marketplace).

import { spawn } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const GITIGNORE_BODY = `_debug/
.runs/
.runs.log
index.html
`;

function git(args, { cwd, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
    if (stdin != null) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

export async function ensureRepo(outDir) {
  if (existsSync(join(outDir, '.git'))) return;
  await git(['init', '--quiet', '-b', 'main'], { cwd: outDir });
  await git(['config', 'user.email', 'protocol-info@local'], { cwd: outDir });
  await git(['config', 'user.name', 'protocol-info'], { cwd: outDir });
  await writeFile(join(outDir, '.gitignore'), GITIGNORE_BODY);
}

export async function commit(outDir, { paths, message, runId }) {
  for (const p of paths) {
    try {
      await git(['add', '--', p], { cwd: outDir });
    } catch (err) {
      // Pathspec missing on disk: treat as "nothing to add" for this path.
      // The empty-staging check below converts the overall call into a no-op.
      if (!/did not match any files/i.test(err.message)) throw err;
    }
  }
  // Detect empty staging area: `git diff --cached --quiet` exits non-zero
  // when there ARE staged changes, so we invert.
  const hasStaged = await new Promise((resolve) => {
    const proc = spawn('git', ['diff', '--cached', '--quiet'], { cwd: outDir, stdio: 'ignore' });
    proc.on('close', (code) => resolve(code !== 0));
  });
  if (!hasStaged) return null;

  const args = ['commit', '--quiet', '-m', message];
  if (runId) args.push('--trailer', `Run-Id: ${runId}`);
  await git(args, { cwd: outDir });
  const { stdout } = await git(['rev-parse', '--short', 'HEAD'], { cwd: outDir });
  return stdout.trim();
}

const LOG_SEP = '\x1f'; // ASCII Unit Separator
const LOG_REC = '\x1e'; // ASCII Record Separator

export async function log(outDir, { slug, limit = 50 }) {
  const format = ['%H', '%ct', '%s', '%(trailers:key=Run-Id,valueonly)'].join(LOG_SEP) + LOG_REC;
  let stdout = '';
  try {
    ({ stdout } = await git(
      ['log', `-${limit}`, `--format=${format}`, '--', `${slug}/`],
      { cwd: outDir }
    ));
  } catch (err) {
    // Empty repo: git log exits 128. Treat as no history.
    if (/does not have any commits yet|unknown revision/i.test(err.message)) return [];
    throw err;
  }
  return stdout
    .split(LOG_REC)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, ct, message, runId] = rec.split(LOG_SEP);
      return {
        sha: sha.slice(0, 12),
        ts: new Date(Number(ct) * 1000).toISOString(),
        message,
        runId: runId.trim() || null,
      };
    });
}

export async function diff(outDir, { slug, fromSha, toSha }) {
  const { stdout } = await git(
    ['diff', fromSha, toSha, '--', `${slug}/`],
    { cwd: outDir }
  );
  return stdout;
}

export async function restore(outDir, { slug, sha }) {
  await git(['checkout', sha, '--', `${slug}/`], { cwd: outDir });
}

export async function isClean(outDir, { slug }) {
  const { stdout } = await git(
    ['status', '--porcelain', '--', `${slug}/`],
    { cwd: outDir }
  );
  return stdout.trim() === '';
}
