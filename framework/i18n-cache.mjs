import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest } from './manifest-loader.mjs';

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

export async function clearI18nSidecars(slugDir, { manifest = null, manifestPath = null } = {}) {
  const out = await resolveOutput({ manifest, manifestPath });
  const debugDir = out.debug_dir || '_debug';
  await rm(join(slugDir, debugDir, 'i18n'), { recursive: true, force: true });
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
