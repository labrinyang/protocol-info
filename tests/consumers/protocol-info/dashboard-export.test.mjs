import { strict as assert } from 'node:assert';
import { buildImportFile } from '../../../consumers/protocol-info/post/dashboard-export.mjs';

export const tests = [
  {
    name: 'no translations → 1 record (locale=en, sources stripped)',
    fn: async () => {
      const file = buildImportFile({
        record: { slug: 's', displayName: 'S', sources: ['x'] },
        translations: {},
      });
      assert.equal(file.version, '1.0');
      assert.equal(file.data.length, 1);
      assert.equal(file.data[0].locale, 'en');
      assert.equal('sources' in file.data[0], false);
      assert.deepEqual(Object.keys(file.data[0]).slice(0, 3), ['slug', 'locale', 'displayName']);
    },
  },
  {
    name: '2 translations → 3 records with mapped locale codes',
    fn: async () => {
      const file = buildImportFile({
        record: { slug: 's', displayName: 'S', description: 'EN', members: [{ memberName: 'A', memberPosition: 'EN_POS', oneLiner: 'EN_OL' }] },
        translations: {
          zh_CN: { description: 'ZH', members: [{ memberPosition: 'ZH_POS', oneLiner: 'ZH_OL' }] },
          ja_JP: { description: 'JA', members: [{ memberPosition: 'JA_POS', oneLiner: 'JA_OL' }] },
        },
      });
      assert.equal(file.data.length, 3);
      const codes = file.data.map(d => d.locale).sort();
      assert.deepEqual(codes, ['en', 'ja', 'zh-cn']);
      const zh = file.data.find(d => d.locale === 'zh-cn');
      assert.equal(zh.description, 'ZH');
      assert.equal(zh.members[0].memberName, 'A');
      assert.equal(zh.members[0].memberPosition, 'ZH_POS');
    },
  },
];
