import { join } from 'node:path';
import { loadManifest } from './manifest-loader.mjs';
import { runNormalizers } from './normalizer-stage.mjs';
import { readJsonDefault } from './record-state.mjs';

export async function normalizeRecordEnvelope(
  outputRoot,
  { slug, envelope, manifestPath, normalizerContext = {} },
) {
  const manifest = await loadManifest(manifestPath);
  const slugDir = join(outputRoot, slug);
  const evidence = await readJsonDefault(join(slugDir, '_debug', 'rootdata.json'), {});
  const context = { env: process.env, ...normalizerContext };
  const result = await runNormalizers({
    normalizers: manifest._abs.normalizers || [],
    record: envelope.record,
    evidence,
    manifest,
    incomingChanges: envelope.changes || [],
    incomingGaps: envelope.gaps || [],
    outputRoot,
    slugDir,
    ...context,
  });
  return {
    ...envelope,
    record: result.record,
    changes: result.changes,
    gaps: result.gaps,
  };
}
