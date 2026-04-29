import { cleanupCreatedLogoAssets } from './logo-assets.mjs';
import { normalizeRecordEnvelope } from './record-normalizer.mjs';

export function createWriteCommandContext(outputRoot, { slug, manifestPath, ctx = {} }) {
  const createdLogoAssetPaths = [];
  const logoAssetPathsToCommit = [];

  const normalizeEnvelope = ctx.normalizeEnvelope || ((envelope) => normalizeRecordEnvelope(outputRoot, {
    slug,
    envelope,
    manifestPath,
    normalizerContext: { ...(ctx.normalizerContext || {}), createdLogoAssetPaths, logoAssetPathsToCommit },
  }));

  return {
    createdLogoAssetPaths,
    logoAssetPathsToCommit,
    normalizeEnvelope,
    assetPathsToCommit() {
      return [...new Set(logoAssetPathsToCommit)];
    },
    async cleanupCreatedAssets() {
      await cleanupCreatedLogoAssets(outputRoot, createdLogoAssetPaths);
    },
  };
}

export function writeValidationFailure(stderr, commandName, validation, outcome = 'Record NOT written.') {
  stderr.write(`${commandName}: validation failed (${validation.errors.length} errors). ${outcome}\n`);
  for (const e of validation.errors.slice(0, 5)) {
    stderr.write(`  ${typeof e === 'string' ? e : `${e.path || '/'}: ${e.message}`}\n`);
  }
}
