import { existsSync } from 'node:fs';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const LOGO_CDN_BASE = 'https://uni.onekey-asset.com/static/logo';
export const LOGO_ASSET_FOLDERS = Object.freeze([
  'protocol-member-logo',
  'protocol-logo',
  'audit-logo',
]);

const LOGO_FOLDER_SET = new Set(LOGO_ASSET_FOLDERS);

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
  const recordPath = join(outputRoot, slug, 'record.json');
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
  const unique = [...new Set(relPaths)].filter(isLogoAssetPath);
  for (const rel of unique) {
    await rm(join(outputRoot, rel), { force: true });
    const folder = rel.split('/')[0];
    try {
      await rmdir(join(outputRoot, folder));
    } catch {
      // Folder is not empty or does not exist; either is fine.
    }
  }
}
