import { readFile, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadManifest } from './manifest-loader.mjs';
import { recordIdentityError } from './record-state.mjs';

export function canonicalImportEnvelopeError(envelope, { slug, provider = slug }) {
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.data) || envelope.data.length === 0) {
    return 'canonical import is not a non-empty data envelope';
  }
  for (let index = 0; index < envelope.data.length; index += 1) {
    const identityError = recordIdentityError(envelope.data[index], { slug, provider });
    if (identityError) return `canonical import data[${index}] ${identityError}`;
  }
  return null;
}

async function readCanonicalImport(importPath) {
  let source;
  try {
    source = await readFile(importPath, 'utf8');
  } catch (err) {
    return { envelope: null, error: `canonical import was not written: ${err.message}` };
  }
  try {
    return { envelope: JSON.parse(source), error: null };
  } catch (err) {
    return { envelope: null, error: `canonical import is not valid JSON: ${err.message}` };
  }
}

export async function runCanonicalPostProcessing({
  runPostProcessing,
  slugDir,
  manifestPath,
  manifest = null,
  slug,
  provider = slug,
}) {
  if (typeof runPostProcessing !== 'function') throw new Error('post-processing runner is required');
  const resolvedManifest = manifest || await loadManifest(manifestPath);
  const importPath = join(slugDir, resolvedManifest.output?.import_filename || 'record.import.json');
  await unlink(importPath).catch((err) => {
    if (err?.code !== 'ENOENT') throw err;
  });

  const result = await runPostProcessing({ slugDir, manifestPath });
  const code = typeof result === 'number' ? result : result?.code;
  if (code !== 0) {
    return {
      ok: false,
      code: Number.isInteger(code) && code !== 0 ? code : 1,
      error: `post-processing exited ${code ?? 'without a status'}`,
      importPath,
      result,
    };
  }

  const canonical = await readCanonicalImport(importPath);
  const envelopeError = canonical.error
    || canonicalImportEnvelopeError(canonical.envelope, { slug, provider });
  if (envelopeError) {
    return {
      ok: false,
      code: 1,
      error: `${basename(importPath)} invalid: ${envelopeError}`,
      importPath,
      result,
      envelope: canonical.envelope,
    };
  }
  return {
    ok: true,
    code: 0,
    error: null,
    importPath,
    result,
    envelope: canonical.envelope,
  };
}
