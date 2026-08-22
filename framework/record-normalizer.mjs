import { join } from 'node:path';
import { loadManifest } from './manifest-loader.mjs';
import { runNormalizers } from './normalizer-stage.mjs';
import { bindRecordIdentity, readJsonDefault } from './record-state.mjs';
import { assertSafeSlugLocation, safeSlugDir } from './safe-path.mjs';

export async function normalizeRecordEnvelope(
  outputRoot,
  { slug, provider = slug, envelope, manifestPath, normalizerContext = {} },
) {
  const manifest = await loadManifest(manifestPath);
  await assertSafeSlugLocation(outputRoot, slug);
  const slugDir = safeSlugDir(outputRoot, slug);
  const record = bindRecordIdentity(envelope?.record, { slug, provider });
  const evidence = await readJsonDefault(join(slugDir, '_debug', 'rootdata.json'), {});
  const context = { env: process.env, ...normalizerContext };
  const result = await runNormalizers({
    normalizers: manifest._abs.normalizers || [],
    record,
    evidence,
    manifest,
    incomingChanges: envelope.changes || [],
    incomingGaps: envelope.gaps || [],
    outputRoot,
    slugDir,
    ...context,
  });
  const normalizedRecord = bindRecordIdentity(result.record, { slug, provider });
  return {
    ...envelope,
    record: normalizedRecord,
    changes: result.changes,
    gaps: result.gaps,
  };
}
