import { ensureRepo, isClean, resetSlugToHead, commit } from './version-store.mjs';
import { buildOutBrowser } from './out-browser.mjs';

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

export async function commitAndRebuild(
  outputRoot,
  { slug, message, runId, paths = [`${slug}/`] },
  { rebuild = buildOutBrowser } = {},
) {
  const sha = await commit(outputRoot, { paths, message, runId });
  const browserPath = await rebuild(outputRoot);
  return { sha, browserPath };
}
