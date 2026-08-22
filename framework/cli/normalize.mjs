// framework/cli/normalize.mjs — CLI shim around runNormalizers.
// Reads R2-merged record + evidence + accumulated changes/gaps; appends
// deterministic normalizer changes; writes new record/changes/gaps files.

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { loadManifest } from '../manifest-loader.mjs';
import { runNormalizers } from '../normalizer-stage.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

async function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2));
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const manifestPath = arg('manifest');
const recordIn = arg('record-in');
const evidencePath = arg('evidence', null);
const changesIn = arg('changes-in', null);
const gapsIn = arg('gaps-in', null);
const recordOut = arg('record-out');
const changesOut = arg('changes-out', null);
const gapsOut = arg('gaps-out', null);
const outputRoot = arg('output-root', null);
const slugDir = arg('slug-dir', null);
const createdAssetsOut = arg('created-assets-out', null);
const assetsToCommitOut = arg('assets-to-commit-out', null);

if (!manifestPath || !recordIn || !recordOut) {
  console.error('usage: normalize.mjs --manifest M --record-in R [--evidence E] [--changes-in C] [--gaps-in G] --record-out R2 [--changes-out C2] [--gaps-out G2] [--output-root OUT] [--slug-dir DIR]');
  process.exit(2);
}

const manifest = await loadManifest(manifestPath);
const record = JSON.parse(await readFile(recordIn, 'utf8'));

let evidence = {};
if (evidencePath) {
  try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
  catch { /* missing evidence is ok */ }
}

let incomingChanges = [];
if (changesIn) {
  try { incomingChanges = JSON.parse(await readFile(changesIn, 'utf8')); }
  catch { incomingChanges = []; }
}
let incomingGaps = [];
if (gapsIn) {
  try { incomingGaps = JSON.parse(await readFile(gapsIn, 'utf8')); }
  catch { incomingGaps = []; }
}

const createdLogoAssetPaths = [];
const logoAssetPathsToCommit = [];
if (createdAssetsOut) await writeJsonAtomically(createdAssetsOut, []);
if (assetsToCommitOut) await writeJsonAtomically(assetsToCommitOut, []);
const registerLogoAssetMutation = createdAssetsOut
  ? async (mutation) => {
      createdLogoAssetPaths.push(mutation);
      await writeJsonAtomically(createdAssetsOut, createdLogoAssetPaths);
    }
  : null;
const result = await runNormalizers({
  normalizers: manifest._abs.normalizers || [],
  record, evidence, manifest, incomingChanges, incomingGaps,
  outputRoot, slugDir, env: process.env, createdLogoAssetPaths, logoAssetPathsToCommit,
  registerLogoAssetMutation,
});

await writeFile(recordOut, JSON.stringify(result.record, null, 2));
if (changesOut) await writeFile(changesOut, JSON.stringify(result.changes, null, 2));
if (gapsOut) await writeFile(gapsOut, JSON.stringify(result.gaps, null, 2));
if (createdAssetsOut) await writeJsonAtomically(createdAssetsOut, createdLogoAssetPaths);
if (assetsToCommitOut) {
  await writeJsonAtomically(assetsToCommitOut, [...new Set(logoAssetPathsToCommit)]);
}
