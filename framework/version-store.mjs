// framework/version-store.mjs — git wrapper for out/.git history layer.
//
// Pure shell-out via child_process.spawn. No libgit2, no isomorphic-git —
// `git` on PATH is already required for the plugin (installed via Claude
// Code's marketplace).

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const GITIGNORE_BODY = `_debug/
.runs/
.runs.log
index.html
summary.tsv
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
  if (!existsSync(join(outDir, '.git'))) {
    await git(['init', '--quiet', '-b', 'main'], { cwd: outDir });
  }
  await git(['config', 'user.email', 'protocol-info@local'], { cwd: outDir });
  await git(['config', 'user.name', 'protocol-info'], { cwd: outDir });
  await git(['config', 'commit.gpgsign', 'false'], { cwd: outDir });
  await ensureGitignore(outDir);
}

async function ensureGitignore(outDir) {
  const path = join(outDir, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // Missing .gitignore in an existing out/.git repo: recreate below.
  }
  const lines = existing.split(/\r?\n/).filter(Boolean);
  const seen = new Set(lines);
  let changed = false;
  for (const line of GITIGNORE_BODY.trim().split('\n')) {
    if (!seen.has(line)) {
      lines.push(line);
      seen.add(line);
      changed = true;
    }
  }
  if (changed || existing === '') {
    await writeFile(path, lines.join('\n') + '\n');
  }
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
  // Detect empty staging area scoped to the requested pathspecs. Unrelated
  // staged files must not get pulled into this logical action's commit.
  const hasStaged = await new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('git', ['diff', '--cached', '--quiet', '--', ...paths], {
      cwd: outDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('close', (code) => {
      if (code === 0) resolve(false);
      else if (code === 1) resolve(true);
      else reject(new Error(`git diff --cached exited ${code}: ${stderr.trim()}`));
    });
  });
  if (!hasStaged) return null;

  const args = ['commit', '--quiet', '-m', message];
  if (runId) args.push('--trailer', `Run-Id: ${runId}`);
  args.push('--', ...paths);
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
  const pathspec = `${slug}/`;
  await git(['rev-parse', '--verify', `${sha}^{commit}`], { cwd: outDir });
  await git(['rm', '-r', '--quiet', '--ignore-unmatch', '--', pathspec], { cwd: outDir });
  await git(['clean', '-fd', '--', pathspec], { cwd: outDir });
  await git(['checkout', sha, '--', pathspec], { cwd: outDir });
}

async function hasHead(outDir) {
  try {
    await git(['rev-parse', '--verify', 'HEAD'], { cwd: outDir });
    return true;
  } catch {
    return false;
  }
}

export async function resetSlugToHead(outDir, { slug }) {
  const pathspec = `${slug}/`;
  if (await hasHead(outDir)) {
    await git(['reset', '--quiet', 'HEAD', '--', pathspec], { cwd: outDir });
    try {
      await git(['checkout', '--quiet', 'HEAD', '--', pathspec], { cwd: outDir });
    } catch (err) {
      // The slug may not exist in HEAD yet (first failed crawl). In that case
      // the clean step below removes non-ignored generated files.
      if (!/did not match any file|pathspec/i.test(err.message)) throw err;
    }
  }
  await git(['clean', '-fd', '--', pathspec], { cwd: outDir });
}

export async function isClean(outDir, { slug }) {
  const { stdout } = await git(
    ['status', '--porcelain', '--', `${slug}/`],
    { cwd: outDir }
  );
  return stdout.trim() === '';
}
