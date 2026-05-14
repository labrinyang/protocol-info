import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest } from './manifest-loader.mjs';
import { normalizeI18nLocaleCode } from './i18n-locales.mjs';

async function resolveOutput({ manifest, manifestPath }) {
  if (manifest) return manifest.output || {};
  if (manifestPath) {
    try {
      const loaded = await loadManifest(manifestPath);
      return loaded.output || {};
    } catch {
      // Unit tests and injected command contexts often use a dummy manifest
      // path. Default artifact names are still the framework contract.
    }
  }
  return {};
}

async function resolveManifestOptional(manifest, manifestPath) {
  if (manifest) return manifest;
  if (!manifestPath) return null;
  try {
    return await loadManifest(manifestPath);
  } catch {
    return null;
  }
}

export async function clearI18nSidecars(slugDir, { manifest = null, manifestPath = null } = {}) {
  const out = await resolveOutput({ manifest, manifestPath });
  const debugDir = out.debug_dir || '_debug';
  await rm(join(slugDir, debugDir, 'i18n'), { recursive: true, force: true });
}

export async function listTranslationSidecars(slugDir, { manifest = null, manifestPath = null } = {}) {
  const resolvedManifest = await resolveManifestOptional(manifest, manifestPath);
  const out = await resolveOutput({ manifest: resolvedManifest, manifestPath });
  const debugDir = out.debug_dir || '_debug';
  const i18nDir = join(slugDir, debugDir, 'i18n');
  const codes = new Set();
  try {
    for (const f of await readdir(i18nDir)) {
      if (!f.endsWith('.json') || f.endsWith('.envelope.json') || f === 'failures.log') continue;
      codes.add(normalizeI18nLocaleCode(f.slice(0, -'.json'.length), resolvedManifest || {}));
    }
  } catch {
    // Missing i18n debug directory simply means there are no sidecars yet.
  }
  return codes;
}

export async function seedSidecarsFromFull(slugDir, { manifest = null, manifestPath = null, overwrite = false } = {}) {
  const resolvedManifest = await resolveManifestOptional(manifest, manifestPath);
  const out = await resolveOutput({ manifest: resolvedManifest, manifestPath });
  const fullFile = join(slugDir, out.full_filename || 'record.full.json');
  let full;
  try {
    full = JSON.parse(await readFile(fullFile, 'utf8'));
  } catch {
    return [];
  }
  const translations = full?.i18n;
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) return [];

  const debugDir = out.debug_dir || '_debug';
  const i18nDir = join(slugDir, debugDir, 'i18n');
  await mkdir(i18nDir, { recursive: true });
  const seeded = [];
  for (const [rawCode, translation] of Object.entries(translations)) {
    const code = normalizeI18nLocaleCode(rawCode, resolvedManifest || {});
    if (!code || translation == null) continue;
    const sidecar = join(i18nDir, `${code}.json`);
    if (!overwrite && existsSync(sidecar)) continue;
    await writeFile(sidecar, JSON.stringify(translation, null, 2) + '\n');
    seeded.push(code);
  }
  return seeded;
}

export async function invalidateI18nArtifacts(slugDir, { manifest = null, manifestPath = null } = {}) {
  const out = await resolveOutput({ manifest, manifestPath });
  await clearI18nSidecars(slugDir, { manifest: manifest || { output: out } });
  await rm(join(slugDir, out.full_filename || 'record.full.json'), { force: true });

  const metaPath = join(slugDir, out.meta_filename || 'meta.json');
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    if (Object.hasOwn(meta, 'i18n')) {
      delete meta.i18n;
      await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
    }
  } catch {
    // Missing or malformed meta should not block source-record writes.
  }
}
