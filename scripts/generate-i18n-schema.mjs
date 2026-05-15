#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildI18nSchema } from '../framework/i18n-schema-generator.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST = resolve(REPO_ROOT, 'consumers', 'protocol-info', 'manifest.json');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const check = process.argv.includes('--check');
const manifestPath = resolve(arg('manifest', DEFAULT_MANIFEST));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const consumerRoot = dirname(manifestPath);
const fullSchemaPath = resolve(consumerRoot, manifest.schemas.full);
const i18nSchemaPath = resolve(consumerRoot, manifest.i18n.schema);
const fullSchema = JSON.parse(await readFile(fullSchemaPath, 'utf8'));
const generated = buildI18nSchema({
  fullSchema,
  translatableFields: manifest.i18n.translatable_fields,
  fieldCaps: manifest.i18n.field_caps || {},
});
const body = JSON.stringify(generated, null, 2) + '\n';

if (check) {
  const existing = await readFile(i18nSchemaPath, 'utf8');
  if (existing !== body) {
    console.error(`i18n schema is stale: ${i18nSchemaPath}`);
    console.error('Run: node scripts/generate-i18n-schema.mjs');
    process.exit(1);
  }
  console.log(`i18n schema up to date: ${i18nSchemaPath}`);
} else {
  await writeFile(i18nSchemaPath, body);
  console.log(`wrote ${i18nSchemaPath}`);
}
