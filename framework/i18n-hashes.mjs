import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseI18nPath } from './i18n-schema-generator.mjs';

const HASH_VERSION = 1;

export function collectTranslatableLeafValues(record, fields) {
  const out = {};
  for (const field of fields || []) {
    collectPath(record, parseI18nPath(field), out, '');
  }
  return out;
}

export function sourceHashesFor(record, fields) {
  const leaves = collectTranslatableLeafValues(record, fields);
  return Object.fromEntries(
    Object.entries(leaves).map(([path, value]) => [path, hashValue(value)]),
  );
}

export function localeHashesMatch(meta, locale, hashes) {
  const existing = meta?.locales?.[locale];
  if (!existing || typeof existing !== 'object') return false;
  return Object.entries(hashes).every(([path, hash]) => existing[path] === hash);
}

export async function readSourceHashMeta(slugDir, { manifest = null } = {}) {
  try {
    const raw = await readFile(sourceHashFile(slugDir, { manifest }), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== HASH_VERSION) return emptyMeta();
    return {
      version: HASH_VERSION,
      locales: parsed.locales && typeof parsed.locales === 'object' ? parsed.locales : {},
    };
  } catch {
    return emptyMeta();
  }
}

export async function writeLocaleSourceHashes(slugDir, locales, hashes, { manifest = null } = {}) {
  const file = sourceHashFile(slugDir, { manifest });
  const meta = await readSourceHashMeta(slugDir, { manifest });
  for (const locale of locales) {
    meta.locales[locale] = {
      ...(meta.locales[locale] || {}),
      ...hashes,
    };
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

export function sourceHashFile(slugDir, { manifest = null } = {}) {
  const debugDir = manifest?.output?.debug_dir || '_debug';
  return join(slugDir, debugDir, 'i18n-meta', 'source-hashes.json');
}

function emptyMeta() {
  return { version: HASH_VERSION, locales: {} };
}

function collectPath(source, segments, out, concretePrefix) {
  if (segments.length === 0) {
    out[concretePrefix] = source;
    return;
  }

  const [segment, ...rest] = segments;
  if (segment === '[]') {
    if (!Array.isArray(source)) return;
    source.forEach((item, index) => {
      collectPath(item, rest, out, `${concretePrefix}[${index}]`);
    });
    return;
  }

  if (!source || typeof source !== 'object' || !(segment in source)) return;
  const nextPrefix = concretePrefix ? `${concretePrefix}.${segment}` : segment;
  collectPath(source[segment], rest, out, nextPrefix);
}

function hashValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}
