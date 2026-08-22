import { ensureRepo, isClean, resetSlugToHead, commit } from './version-store.mjs';
import { cleanupCreatedLogoAssets } from './logo-assets.mjs';

export async function preflightWritableSlug(outputRoot, slug, { forceOverwrite = false } = {}) {
  await ensureRepo(outputRoot);
  if (forceOverwrite) return;
  if (!(await isClean(outputRoot, { slug }))) {
    throw new Error(
      `${slug}: uncommitted changes in out/${slug}/ — refusing to overwrite. ` +
      'Commit or discard them first, or pass --force-overwrite.'
    );
  }
}

export async function rollbackSlug(outputRoot, slug) {
  await resetSlugToHead(outputRoot, { slug });
}

export async function rollbackSlugAndCleanup(
  outputRoot,
  slug,
  createdLogoAssetPaths = [],
  { rollback = rollbackSlug, cleanup = cleanupCreatedLogoAssets } = {},
) {
  const errors = [];
  try {
    await rollback(outputRoot, slug);
  } catch (err) {
    errors.push(err);
  }
  try {
    await cleanup(outputRoot, createdLogoAssetPaths);
  } catch (err) {
    errors.push(err);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const details = errors.map((err) => err?.message || String(err)).join('; ');
    throw new AggregateError(
      errors,
      `failed to roll back ${slug} and clean up shared logo assets: ${details}`,
    );
  }
}

export async function commitAndRebuild(
  outputRoot,
  { slug, message, runId, paths = null, extraPaths = [] },
  { rebuild = null } = {},
) {
  const commitPaths = [...new Set(paths || [`${slug}/`, ...extraPaths])];
  const sha = await commit(outputRoot, { paths: commitPaths, message, runId });
  const browserPath = typeof rebuild === 'function' ? await rebuild(outputRoot) : null;
  return { sha, browserPath };
}
