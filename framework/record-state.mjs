import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeSlugLocation, safeSlugDir } from './safe-path.mjs';

export function slugDir(outputRoot, slug) {
  return safeSlugDir(outputRoot, slug);
}

export function recordIdentityError(record, {
  slug,
  provider = slug,
  allowMissing = false,
} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record is not an object';
  if (!(allowMissing && record.slug === undefined) && record.slug !== slug) {
    return `record.slug identity mismatch: expected ${JSON.stringify(slug)}, got ${JSON.stringify(record.slug)}`;
  }
  if (!(allowMissing && record.provider === undefined) && record.provider !== provider) {
    return `record.provider identity mismatch: expected ${JSON.stringify(provider)}, got ${JSON.stringify(record.provider)}`;
  }
  return null;
}

export function bindRecordIdentity(record, { slug, provider = slug } = {}) {
  const identityError = recordIdentityError(record, { slug, provider, allowMissing: true });
  if (identityError) throw new Error(identityError);
  return {
    ...record,
    slug: record.slug ?? slug,
    provider: record.provider ?? provider,
  };
}

export async function readJsonDefault(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function loadRecordEnvelope(outputRoot, { slug }) {
  await assertSafeSlugLocation(outputRoot, slug);
  const dir = slugDir(outputRoot, slug);
  const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8'));
  return {
    record,
    findings: await readJsonDefault(join(dir, 'findings.json'), []),
    changes: await readJsonDefault(join(dir, 'changes.json'), []),
    gaps: await readJsonDefault(join(dir, 'gaps.json'), []),
  };
}

export async function writeRecordEnvelope(outputRoot, { slug, provider = slug, envelope }) {
  await assertSafeSlugLocation(outputRoot, slug);
  const dir = slugDir(outputRoot, slug);
  const record = bindRecordIdentity(envelope?.record, { slug, provider });
  await writeFile(join(dir, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  await writeFile(join(dir, 'findings.json'), JSON.stringify(envelope.findings || [], null, 2) + '\n');
  await writeFile(join(dir, 'changes.json'), JSON.stringify(envelope.changes || [], null, 2) + '\n');
  await writeFile(join(dir, 'gaps.json'), JSON.stringify(envelope.gaps || [], null, 2) + '\n');
}
