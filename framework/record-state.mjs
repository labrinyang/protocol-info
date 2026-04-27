import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function slugDir(outputRoot, slug) {
  return join(outputRoot, slug);
}

export async function readJsonDefault(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function loadRecordEnvelope(outputRoot, { slug }) {
  const dir = slugDir(outputRoot, slug);
  const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8'));
  return {
    record,
    findings: await readJsonDefault(join(dir, 'findings.json'), []),
    changes: await readJsonDefault(join(dir, 'changes.json'), []),
    gaps: await readJsonDefault(join(dir, 'gaps.json'), []),
  };
}

export async function writeRecordEnvelope(outputRoot, { slug, envelope }) {
  const dir = slugDir(outputRoot, slug);
  await writeFile(join(dir, 'record.json'), JSON.stringify(envelope.record, null, 2) + '\n');
  await writeFile(join(dir, 'findings.json'), JSON.stringify(envelope.findings || [], null, 2) + '\n');
  await writeFile(join(dir, 'changes.json'), JSON.stringify(envelope.changes || [], null, 2) + '\n');
  await writeFile(join(dir, 'gaps.json'), JSON.stringify(envelope.gaps || [], null, 2) + '\n');
}
