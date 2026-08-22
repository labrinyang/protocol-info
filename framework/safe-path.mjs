import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || !SAFE_SLUG_RE.test(slug)) {
    throw Object.assign(new Error(
      `unsafe protocol slug ${JSON.stringify(slug)}; expected 1-64 lowercase letters, digits, or hyphens`,
    ), { kind: 'arg_invalid', slug });
  }
  return slug;
}

export function safeSlugDir(outputRoot, slug) {
  assertSafeSlug(slug);
  if (typeof outputRoot !== 'string' || outputRoot.trim() === '') {
    throw Object.assign(new Error('output root is required'), { kind: 'arg_invalid' });
  }
  return join(outputRoot, slug);
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function assertNoSymlinkDescendants(slug, dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error(`${slug}: refusing symlink inside protocol directory: ${entry.name}`), {
        kind: 'unsafe_path',
        slug,
      });
    }
    if (info.isDirectory()) await assertNoSymlinkDescendants(slug, entryPath);
  }
}

export async function assertSafeSlugLocation(outputRoot, slug) {
  const target = safeSlugDir(outputRoot, slug);
  const rootAbsolute = resolve(outputRoot);
  let rootReal = rootAbsolute;
  try {
    rootReal = await realpath(rootAbsolute);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  let info;
  try {
    info = await lstat(target);
  } catch (err) {
    if (err?.code === 'ENOENT') return target;
    throw err;
  }
  if (info.isSymbolicLink()) {
    throw Object.assign(new Error(`${slug}: refusing protocol directory symlink`), {
      kind: 'unsafe_path',
      slug,
    });
  }
  if (!info.isDirectory()) {
    throw Object.assign(new Error(`${slug}: protocol path exists but is not a directory`), {
      kind: 'unsafe_path',
      slug,
    });
  }

  const targetReal = await realpath(target);
  if (!isWithin(rootReal, targetReal)) {
    throw Object.assign(new Error(`${slug}: protocol directory escapes the output root`), {
      kind: 'unsafe_path',
      slug,
    });
  }
  await assertNoSymlinkDescendants(slug, targetReal);
  return target;
}
