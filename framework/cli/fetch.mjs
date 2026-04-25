// framework/cli/fetch.mjs — bash-callable entry. Reads a manifest, runs all
// declared fetchers, writes the evidence packet to --output.
//
// Usage: node framework/cli/fetch.mjs --manifest <path> --slug X --display-name Y --hints Z [--rootdata-id ID] --output OUT.json

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { dispatchFetchers } from '../fetcher-dispatcher.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const manifestPath = arg('manifest');
const slug = arg('slug');
const displayName = arg('display-name');
const hints = arg('hints', '');
const rootdataId = arg('rootdata-id', '');
const output = arg('output');

if (!manifestPath || !slug || !displayName || !output) {
  console.error('usage: fetch.mjs --manifest <path> --slug X --display-name Y [--hints Z] [--rootdata-id ID] --output OUT');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const consumerDir = dirname(resolve(manifestPath));

const fetchers = (manifest.fetchers || []).map(f => ({
  ...f,
  module_abs: resolve(consumerDir, f.module),
}));

const packet = await dispatchFetchers({
  fetchers,
  ctx: {
    slug, displayName, hints, rootdataId,
    env: process.env,
    logger: { info: m => console.error(`[fetch] ${m}`), warn: m => console.error(`[fetch:warn] ${m}`) },
  },
});

await writeFile(output, JSON.stringify(packet, null, 2));
process.exit(0);
