import { join } from 'node:path';
import { loadManifest } from './manifest-loader.mjs';
import { invalidateI18nArtifacts } from './i18n-cache.mjs';
import { pathAffectsTranslatableFields, translatableSubsetChanged } from './i18n-fields.mjs';

async function loadManifestForI18nInvalidation(manifestPath) {
  try {
    return await loadManifest(manifestPath);
  } catch {
    return null;
  }
}

export async function invalidateI18nForPath(outputRoot, slug, jsonpath, manifestPath) {
  const manifest = await loadManifestForI18nInvalidation(manifestPath);
  if (!manifest) return false;
  if (!pathAffectsTranslatableFields(jsonpath, manifest.i18n?.translatable_fields || [])) return false;
  await invalidateI18nArtifacts(join(outputRoot, slug), { manifest });
  return true;
}

export async function invalidateI18nForRecordChange(outputRoot, slug, beforeRecord, afterRecord, manifestPath) {
  const manifest = await loadManifestForI18nInvalidation(manifestPath);
  if (!manifest) return false;
  if (!translatableSubsetChanged(beforeRecord, afterRecord, manifest.i18n?.translatable_fields || [])) return false;
  await invalidateI18nArtifacts(join(outputRoot, slug), { manifest });
  return true;
}
