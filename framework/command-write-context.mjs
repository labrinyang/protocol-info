import { cleanupCreatedLogoAssets } from './logo-assets.mjs';
import { normalizeRecordEnvelope } from './record-normalizer.mjs';
import { recordIdentityError } from './record-state.mjs';
import { runCanonicalPostProcessing } from './canonical-post.mjs';

export function createWriteCommandContext(outputRoot, { slug, manifestPath, ctx = {} }) {
  const createdLogoAssetPaths = [];
  const logoAssetPathsToCommit = [];
  let expectedProvider = slug;

  const normalizeEnvelope = (envelope) => {
    if (ctx.normalizeEnvelope) {
      return ctx.normalizeEnvelope(envelope, { slug, provider: expectedProvider });
    }
    return normalizeRecordEnvelope(outputRoot, {
      slug,
      provider: expectedProvider,
      envelope,
      manifestPath,
      normalizerContext: { ...(ctx.normalizerContext || {}), createdLogoAssetPaths, logoAssetPathsToCommit },
    });
  };

  return {
    createdLogoAssetPaths,
    logoAssetPathsToCommit,
    normalizeEnvelope,
    bindExistingRecord(record) {
      const provider = record?.provider ?? slug;
      const identityError = recordIdentityError(record, { slug, provider, allowMissing: true });
      if (identityError) throw new Error(identityError);
      expectedProvider = provider;
      return provider;
    },
    expectedProvider() {
      return expectedProvider;
    },
    runCanonicalPost(runPostProcessing, slugDir, { provider = expectedProvider, manifest = null } = {}) {
      return runCanonicalPostProcessing({
        runPostProcessing,
        slugDir,
        manifestPath,
        manifest,
        slug,
        provider,
      });
    },
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
