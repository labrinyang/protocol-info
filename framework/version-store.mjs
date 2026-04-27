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
