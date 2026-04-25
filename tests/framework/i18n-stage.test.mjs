import { strict as assert } from 'node:assert';
import { extractTranslatable, mergeTranslated } from '../../framework/i18n-stage.mjs';

export const tests = [
  {
    name: 'extractTranslatable picks scalar field',
    fn: async () => {
      const out = extractTranslatable({ description: 'hello', x: 1 }, ['description']);
      assert.deepEqual(out, { description: 'hello' });
    },
  },
  {
    name: 'extractTranslatable picks fields under array index wildcard',
    fn: async () => {
      const out = extractTranslatable(
        { members: [{ memberPosition: 'CEO', oneLiner: 'a', skip: 'x' }, { memberPosition: 'CTO', oneLiner: 'b', skip: 'y' }] },
        ['members[].memberPosition', 'members[].oneLiner']
      );
      assert.deepEqual(out, {
        members: [
          { memberPosition: 'CEO', oneLiner: 'a' },
          { memberPosition: 'CTO', oneLiner: 'b' },
        ],
      });
    },
  },
  {
    name: 'mergeTranslated merges back into a base record',
    fn: async () => {
      const base = { slug: 's', description: 'EN', members: [{ memberName: 'A', memberPosition: 'EN_POS', oneLiner: 'EN_OL' }] };
      const tr = { description: 'ZH', members: [{ memberPosition: 'ZH_POS', oneLiner: 'ZH_OL' }] };
      const out = mergeTranslated(base, tr);
      assert.equal(out.description, 'ZH');
      assert.equal(out.members[0].memberName, 'A');
      assert.equal(out.members[0].memberPosition, 'ZH_POS');
      assert.equal(out.members[0].oneLiner, 'ZH_OL');
    },
  },
];
