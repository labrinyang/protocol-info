import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTranslatablePath } from '../../../framework/i18n-fields.mjs';
import { SUMMARY_COLUMNS, SUMMARY_HEADER } from '../../../framework/summary-schema.mjs';
import { dashboardLocaleFor, DASHBOARD_LOCALE_CODES } from '../../../consumers/protocol-info/post/locale-map.mjs';

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function schemaAt(schema, segments) {
  let node = schema;
  for (const segment of segments) {
    if (segment === '[]') {
      node = node.items;
    } else {
      node = node.properties?.[segment];
    }
    assert.ok(node, `schema missing ${segments.join('.')}`);
  }
  return node;
}

function allowsNull(node) {
  return node.type === 'null' || (Array.isArray(node.type) && node.type.includes('null'));
}

function allowsString(node) {
  return node.type === 'string' || (Array.isArray(node.type) && node.type.includes('string'));
}

export const tests = [
  {
    name: 'i18n schema mirrors full schema for manifest translatable fields',
    fn: async () => {
      const root = join(process.cwd(), 'consumers', 'protocol-info');
      const manifest = await json(join(root, 'manifest.json'));
      const full = await json(join(root, 'schemas', 'full.json'));
      const i18n = await json(join(root, 'schemas', 'i18n.json'));

      for (const field of manifest.i18n.translatable_fields) {
        const segments = parseTranslatablePath(field);
        const source = schemaAt(full, segments);
        const translated = schemaAt(i18n, segments);
        assert.equal(allowsString(translated), true, `${field}: translated field must allow string`);
        assert.equal(allowsNull(translated), allowsNull(source), `${field}: nullability drift`);
        if (source.maxLength != null) {
          assert.ok(translated.maxLength <= source.maxLength, `${field}: maxLength drift`);
        }
        assert.equal(translated.minLength, undefined, `${field}: minLength encourages filler text`);
      }
    },
  },
  {
    name: 'audit item limits are aligned across full and refresh slice schemas',
    fn: async () => {
      const root = join(process.cwd(), 'consumers', 'protocol-info', 'schemas');
      const full = await json(join(root, 'full.json'));
      const auditsSlice = await json(join(root, 'audits.slice.json'));
      assert.equal(full.properties.audits.properties.items.maxItems, 30);
      assert.equal(auditsSlice.properties.audits.properties.items.maxItems, 30);
    },
  },
  {
    name: 'manifest locales all map to known dashboard locales',
    fn: async () => {
      const root = join(process.cwd(), 'consumers', 'protocol-info');
      const manifest = await json(join(root, 'manifest.json'));
      const known = new Set(DASHBOARD_LOCALE_CODES);
      assert.equal(known.has('en'), true);
      for (const entry of manifest.i18n.locale_catalog) {
        const mapped = dashboardLocaleFor(entry.code);
        assert.equal(known.has(mapped), true, `${entry.code} mapped outside dashboard catalog`);
      }
    },
  },
  {
    name: 'summary TSV header is a single shared contract',
    fn: async () => {
      assert.deepEqual(SUMMARY_COLUMNS, ['slug', 'status', 'members', 'funding', 'audits', 'schema', 'source', 'api_status', 'i18n']);
      assert.equal(SUMMARY_HEADER, SUMMARY_COLUMNS.join('\t'));
    },
  },
];
