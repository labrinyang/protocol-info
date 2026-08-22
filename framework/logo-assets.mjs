import { existsSync } from 'node:fs';
import { link, lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { safeSlugDir } from './safe-path.mjs';

export const LOGO_CDN_BASE = 'https://uni.onekey-asset.com/static/logo';
export const LOGO_ASSET_FOLDERS = Object.freeze([
  'protocol-member-logo',
  'protocol-logo',
  'audit-logo',
]);

const LOGO_FOLDER_SET = new Set(LOGO_ASSET_FOLDERS);
const LOGO_STATE_FOLDER = 'protocol-info-logo-assets';
const LOGO_LOCK_TIMEOUT_MS = 5_000;
const PROCESS_IDENTITY_TIMEOUT_MS = 500;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function logoAssetDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureSafeStateDirectory(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`unsafe logo asset state directory: ${path}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`unsafe logo asset state directory: ${path}`);
    }
  }
}

async function logoAssetStatePaths(outputRoot, relPath) {
  const stateRoot = join(tmpdir(), LOGO_STATE_FOLDER);
  await ensureSafeStateDirectory(stateRoot);
  const namespace = join(stateRoot, logoAssetDigest(Buffer.from(resolve(outputRoot))));
  await ensureSafeStateDirectory(namespace);
  const lockRoot = join(namespace, 'locks');
  const ownerRoot = join(namespace, 'owners');
  const rollbackRoot = join(namespace, 'rollbacks');
  await ensureSafeStateDirectory(lockRoot);
  await ensureSafeStateDirectory(ownerRoot);
  await ensureSafeStateDirectory(rollbackRoot);
  const key = logoAssetDigest(Buffer.from(relPath));
  return {
    lockRoot,
    key,
    lockPath: join(lockRoot, `${key}.lock`),
    ownerPath: join(ownerRoot, `${key}.json`),
    rollbackRoot,
  };
}

function logoAssetLockError(message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    kind: 'logo_asset_lock_failed',
  });
}

function logoAssetLockAggregateError(message, operationError, releaseError) {
  return Object.assign(new AggregateError(
    [operationError, releaseError],
    message,
    { cause: operationError },
  ), {
    kind: 'logo_asset_lock_failed',
  });
}

function readProcessStartIdentity(pid) {
  return new Promise((resolvePromise) => {
    const child = spawn('ps', ['-o', 'lstart=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TZ: 'UTC',
        LC_ALL: 'C',
        LANG: 'C',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: 'unknown', reason: 'process identity query timed out' });
    }, PROCESS_IDENTITY_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ status: 'unknown', reason: error.message }));
    child.on('close', (code) => {
      const identity = stdout.trim().replace(/\s+/g, ' ');
      if (code === 0 && identity) {
        finish({ status: 'alive', identity: `ps-lstart:${identity}` });
      } else if (code === 1 && !identity && !stderr.trim()) {
        finish({ status: 'dead' });
      } else {
        finish({
          status: 'unknown',
          reason: `ps exited ${code ?? 'without status'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        });
      }
    });
  });
}

function validLockOwner(owner) {
  return owner
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.token === 'string'
    && LOCK_TOKEN_PATTERN.test(owner.token)
    && typeof owner.processStartIdentity === 'string'
    && owner.processStartIdentity !== '';
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function retryChangedCanonicalLock(lockPath, originalInfo, missingError) {
  const currentInfo = await lstat(lockPath);
  if (!sameFileIdentity(currentInfo, originalInfo)) {
    return readCanonicalLockState(lockPath);
  }
  throw missingError;
}

async function readCanonicalLockState(lockPath) {
  const lockInfo = await lstat(lockPath);
  if (lockInfo.isSymbolicLink() || (!lockInfo.isFile() && !lockInfo.isDirectory())) {
    throw logoAssetLockError(`unsafe logo asset lock path: ${lockPath}`);
  }

  const legacyDirectory = lockInfo.isDirectory();
  const ownerPath = legacyDirectory ? join(lockPath, 'owner.json') : lockPath;
  if (legacyDirectory) {
    let ownerInfo;
    try {
      ownerInfo = await lstat(ownerPath);
    } catch (error) {
      return retryChangedCanonicalLock(
        lockPath,
        lockInfo,
        error?.code === 'ENOENT'
          ? logoAssetLockError(`incomplete logo asset lock owner: ${ownerPath}`)
          : logoAssetLockError(`failed to inspect logo asset lock owner: ${ownerPath}`, error),
      );
    }
    if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) {
      throw logoAssetLockError(`unsafe logo asset lock owner: ${ownerPath}`);
    }
  }

  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  } catch (error) {
    return retryChangedCanonicalLock(
      lockPath,
      lockInfo,
      error?.code === 'ENOENT'
        ? logoAssetLockError(`incomplete logo asset lock owner: ${ownerPath}`, error)
        : logoAssetLockError(`invalid logo asset lock owner: ${ownerPath}`, error),
    );
  }
  if (!validLockOwner(owner)) {
    throw logoAssetLockError(`incomplete logo asset lock owner: ${ownerPath}`);
  }
  return { owner, legacyDirectory, lockInfo };
}

async function ownerIsDefinitelyDead(owner) {
  const current = await readProcessStartIdentity(owner.pid);
  if (current.status === 'dead') return true;
  if (current.status === 'alive') return current.identity !== owner.processStartIdentity;
  return null;
}

async function quarantineDeadLogoAssetLock(lockPath) {
  let lockState;
  try {
    lockState = await readCanonicalLockState(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }

  const { owner, legacyDirectory } = lockState;
  const dead = await ownerIsDefinitelyDead(owner);
  if (dead !== true) return false;

  // The dead owner's token is also the immutable ABA fence. Quarantines are
  // intentionally never deleted: a delayed reaper targeting this token then
  // fails its no-replace publication instead of removing a newer live owner.
  const quarantinePath = `${lockPath}.orphan-${owner.token}`;
  if (!legacyDirectory) {
    try {
      await link(lockPath, quarantinePath);
    } catch (error) {
      if (['ENOENT', 'EEXIST'].includes(error?.code)) return true;
      throw logoAssetLockError(`failed to quarantine dead logo asset lock: ${lockPath}`, error);
    }
    try {
      await unlink(lockPath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw logoAssetLockError(`failed to remove quarantined logo asset lock: ${lockPath}`, error);
    }
  }

  // Compatibility with locks published by the previous directory format. An
  // exclusive empty-directory reservation proves this reaper created the
  // quarantine name. Replacing our own reservation moves the complete legacy
  // directory atomically, without ever replacing a path that predated this
  // attempt. An older rename-based reaper may replace our reservation first;
  // that performs the same safe move and makes our rename observe a race.
  try {
    await mkdir(quarantinePath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') return true;
    throw logoAssetLockError(`failed to quarantine dead logo asset lock: ${lockPath}`, error);
  }
  try {
    await rename(lockPath, quarantinePath);
    return true;
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(error?.code)) return true;
    throw logoAssetLockError(`failed to quarantine dead logo asset lock: ${lockPath}`, error);
  }
}

export async function withLogoAssetLock(outputRoot, relPath, operation) {
  if (!isLogoAssetPath(relPath)) throw new Error(`unsafe logo asset path: ${relPath}`);
  if (typeof operation !== 'function') throw new Error('logo asset lock operation is required');
  let lockPath;
  try {
    ({ lockPath } = await logoAssetStatePaths(outputRoot, relPath));
  } catch (error) {
    throw logoAssetLockError(`failed to initialize logo asset lock state: ${relPath}`, error);
  }
  const lockToken = randomUUID();
  const processIdentity = await readProcessStartIdentity(process.pid);
  if (processIdentity.status !== 'alive') {
    throw logoAssetLockError(
      `could not determine current process identity for logo asset lock: ${processIdentity.reason || 'unknown'}`,
    );
  }
  const owner = {
    pid: process.pid,
    token: lockToken,
    processStartIdentity: processIdentity.identity,
  };
  const candidatePath = `${lockPath}.candidate-${lockToken}`;
  const deadline = Date.now() + LOGO_LOCK_TIMEOUT_MS;
  while (true) {
    let acquired = false;
    try {
      await writeFile(candidatePath, JSON.stringify(owner), {
        flag: 'wx',
        mode: 0o600,
      });
      try {
        // Hard-link publication is atomic and never replaces an existing path,
        // including an empty directory or symlink. The candidate is fully
        // written before it becomes canonical.
        await link(candidatePath, lockPath);
        acquired = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw logoAssetLockError(`failed to publish logo asset lock: ${relPath}`, error);
        }
      }
    } catch (error) {
      if (error?.kind === 'logo_asset_lock_failed') throw error;
      throw logoAssetLockError(`failed to prepare logo asset lock: ${relPath}`, error);
    } finally {
      await rm(candidatePath, { force: true });
    }
    if (acquired) break;

    await quarantineDeadLogoAssetLock(lockPath);
    if (Date.now() >= deadline) {
      throw logoAssetLockError(`timed out waiting for logo asset lock: ${relPath}`);
    }
    await wait(20);
  }

  let operationFailed = false;
  let operationError;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    let ownerAtRelease;
    let releaseError;
    try {
      ownerAtRelease = (await readCanonicalLockState(lockPath)).owner;
    } catch (error) {
      releaseError = logoAssetLockError(
        `failed to verify logo asset lock release: ${relPath}`,
        error,
      );
    }
    if (!releaseError && ownerAtRelease?.token !== lockToken) {
      releaseError = logoAssetLockError(
        `logo asset lock ownership changed before release: ${relPath}`,
      );
    }
    if (!releaseError) {
      try {
        await unlink(lockPath);
      } catch (error) {
        releaseError = logoAssetLockError(`failed to release logo asset lock: ${relPath}`, error);
      }
    }
    if (releaseError && operationFailed) {
      throw logoAssetLockAggregateError(
        `logo asset operation failed and lock release also failed: ${relPath}`,
        operationError,
        releaseError,
      );
    }
    if (releaseError) throw releaseError;
  }
}

export function createLogoAssetGeneration() {
  return randomUUID();
}

export async function readLogoAssetGeneration(outputRoot, relPath) {
  if (!isLogoAssetPath(relPath)) throw new Error(`unsafe logo asset path: ${relPath}`);
  const { ownerPath } = await logoAssetStatePaths(outputRoot, relPath);
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (typeof owner?.generation !== 'string' || owner.generation === '') {
      throw new Error(`invalid logo asset generation state: ${relPath}`);
    }
    return owner.generation;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeLogoAssetGeneration(outputRoot, relPath, generation) {
  if (!isLogoAssetPath(relPath)) throw new Error(`unsafe logo asset path: ${relPath}`);
  const { ownerPath } = await logoAssetStatePaths(outputRoot, relPath);
  if (generation == null) {
    await rm(ownerPath, { force: true });
    return;
  }
  if (typeof generation !== 'string' || generation === '') {
    throw new Error('logo asset generation must be a non-empty string');
  }
  const temporaryPath = `${ownerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify({ generation }));
    await rename(temporaryPath, ownerPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function deferredRollbackPath(outputRoot, relPath, generation) {
  const { rollbackRoot } = await logoAssetStatePaths(outputRoot, relPath);
  return join(rollbackRoot, `${logoAssetDigest(Buffer.from(relPath))}.${logoAssetDigest(Buffer.from(generation))}.json`);
}

async function deferLogoAssetRollback(outputRoot, relPath, mutation) {
  const path = await deferredRollbackPath(outputRoot, relPath, mutation.generation);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(mutation));
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readDeferredLogoAssetRollback(outputRoot, relPath, generation) {
  const path = await deferredRollbackPath(outputRoot, relPath, generation);
  try {
    const mutation = JSON.parse(await readFile(path, 'utf8'));
    if (mutation?.relPath !== relPath || mutation?.generation !== generation) {
      throw new Error(`invalid deferred logo asset rollback state: ${relPath}`);
    }
    return mutation;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function clearDeferredLogoAssetRollback(outputRoot, relPath, generation) {
  await rm(await deferredRollbackPath(outputRoot, relPath, generation), { force: true });
}

export function cdnLogoUrl(folder, filename) {
  if (!LOGO_FOLDER_SET.has(folder)) throw new Error(`unknown logo folder: ${folder}`);
  return `${LOGO_CDN_BASE}/${folder}/${filename}`;
}

function safeAssetFilename(filename) {
  if (typeof filename !== 'string' || filename.trim() === '') return null;
  if (filename.includes('/') || filename.includes('\\')) return null;
  if (filename === '.' || filename === '..') return null;
  if (filename.includes('..')) return null;
  return filename;
}

export function parseCdnLogoPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let parsed;
  let base;
  try {
    parsed = new URL(value);
    base = new URL(`${LOGO_CDN_BASE}/`);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  if (!parsed.pathname.startsWith(base.pathname)) return null;
  const rel = parsed.pathname.slice(base.pathname.length);
  const parts = rel.split('/');
  if (parts.length !== 2) return null;
  const [folder, rawFilename] = parts;
  if (!LOGO_FOLDER_SET.has(folder)) return null;
  let filename = rawFilename;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch {
    return null;
  }
  filename = safeAssetFilename(filename);
  if (!filename) return null;
  return `${folder}/${filename}`;
}

function addLogoPath(paths, value) {
  const rel = parseCdnLogoPath(value);
  if (rel) paths.add(rel);
}

export function isLogoAssetPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (isAbsolute(value) || value.includes('\\') || value.includes('..')) return false;
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [folder, filename] = parts;
  return LOGO_FOLDER_SET.has(folder) && safeAssetFilename(filename) === filename;
}

export function logoAssetPathsForRecord(record) {
  const paths = new Set();
  addLogoPath(paths, record?.providerLogoUrl);
  for (const member of record?.members || []) {
    addLogoPath(paths, member?.avatarUrl);
  }
  for (const item of record?.audits?.items || []) {
    addLogoPath(paths, item?.auditorLogoUrl);
  }
  return [...paths];
}

export async function logoAssetPathsForSlug(outputRoot, slug) {
  const recordPath = join(safeSlugDir(outputRoot, slug), 'record.json');
  if (!existsSync(recordPath)) return [];
  try {
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    return logoAssetPathsForRecord(record)
      .filter((rel) => existsSync(join(outputRoot, rel)));
  } catch {
    return [];
  }
}

export async function cleanupCreatedLogoAssets(outputRoot, relPaths = []) {
  for (const mutation of [...relPaths].reverse()) {
    const rel = typeof mutation === 'string' ? mutation : mutation?.relPath;
    if (!isLogoAssetPath(rel)) continue;
    await withLogoAssetLock(outputRoot, rel, async () => {
      const folder = rel.split('/')[0];
      const folderPath = join(outputRoot, folder);
      const filePath = join(outputRoot, rel);
      try {
        const info = await lstat(folderPath);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(`unsafe logo asset folder: ${folder}`);
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        if (typeof mutation !== 'object' || typeof mutation.restoreBase64 !== 'string') return;
        await mkdir(folderPath, { recursive: true });
      }

      let pending = mutation;
      while (true) {
        let currentBytes = null;
        try {
          const info = await lstat(filePath);
          if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error(`unsafe logo asset restore target: ${rel}`);
          }
          currentBytes = await readFile(filePath);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }

        const currentGeneration = await readLogoAssetGeneration(outputRoot, rel);
        if (typeof pending === 'object' && typeof pending.generation === 'string') {
          if (currentGeneration !== pending.generation) {
            if (currentGeneration !== null) {
              await deferLogoAssetRollback(outputRoot, rel, pending);
            }
            return;
          }
        } else if (currentGeneration !== null) {
          return;
        }

        const previousGeneration = pending?.previousGeneration ?? null;
        if (typeof pending === 'object' && typeof pending.writtenSha256 === 'string') {
          if (currentBytes === null || logoAssetDigest(currentBytes) !== pending.writtenSha256) {
            await writeLogoAssetGeneration(outputRoot, rel, previousGeneration);
          } else if (typeof pending.restoreBase64 === 'string') {
            await writeFile(filePath, Buffer.from(pending.restoreBase64, 'base64'));
            await writeLogoAssetGeneration(outputRoot, rel, previousGeneration);
          } else if (pending.preserveOnRollback === true) {
            await writeLogoAssetGeneration(outputRoot, rel, previousGeneration);
          } else {
            await rm(filePath, { force: true });
            await writeLogoAssetGeneration(outputRoot, rel, previousGeneration);
            try {
              await rmdir(folderPath);
            } catch {
              // Folder is not empty or does not exist; either is fine.
            }
          }
          await clearDeferredLogoAssetRollback(outputRoot, rel, pending.generation);
        } else if (typeof pending === 'object' && typeof pending.restoreBase64 === 'string') {
          await writeFile(filePath, Buffer.from(pending.restoreBase64, 'base64'));
        } else {
          await rm(filePath, { force: true });
        }

        if (!previousGeneration) return;
        pending = await readDeferredLogoAssetRollback(outputRoot, rel, previousGeneration);
        if (!pending) return;
      }
    });
  }
}
