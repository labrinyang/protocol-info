import { strict as assert } from 'node:assert';
import { parse, getAt, setAt } from '../../framework/jsonpath.mjs';

export const tests = [
  {
    name: 'parse handles identifiers and numeric indexes',
    fn: async () => {
      assert.deepEqual(parse('name'), ['name']);
      assert.deepEqual(parse('members[0].oneLiner'), ['members', 0, 'oneLiner']);
      assert.deepEqual(parse('fundingRounds[12].amount_usd'), ['fundingRounds', 12, 'amount_usd']);
    },
  },
  {
    name: 'parse rejects unsupported JSONPath syntax',
    fn: async () => {
      assert.throws(() => parse(''), /non-empty/);
      assert.throws(() => parse('members[*]'), /invalid jsonpath index/);
      assert.throws(() => parse('members[0:2]'), /invalid jsonpath index/);
      assert.throws(() => parse('members..name'), /expected identifier/);
      assert.throws(() => parse('members.'), /trailing dot/);
      assert.throws(() => parse('$..name'), /expected identifier/);
    },
  },
  {
    name: 'getAt returns nested values',
    fn: async () => {
      const record = {
        name: 'Pendle',
        members: [{ oneLiner: 'core contributor' }],
        fundingRounds: [{ amount_usd: 1000 }],
      };
      assert.equal(getAt(record, 'name'), 'Pendle');
      assert.equal(getAt(record, 'members[0].oneLiner'), 'core contributor');
      assert.equal(getAt(record, 'fundingRounds[0].amount_usd'), 1000);
    },
  },
  {
    name: 'getAt errors on missing paths',
    fn: async () => {
      const record = { members: [] };
      assert.throws(() => getAt(record, 'members[0].name'), /not found/);
      assert.throws(() => getAt(record, 'missing.value'), /not found/);
    },
  },
  {
    name: 'setAt updates existing values and missing object leaves',
    fn: async () => {
      const record = { name: 'Old', metadata: {}, members: [{ oneLiner: 'old' }] };
      setAt(record, 'name', 'New');
      setAt(record, 'metadata.description', 'A protocol');
      setAt(record, 'members[0].oneLiner', 'new');
      assert.equal(record.name, 'New');
      assert.equal(record.metadata.description, 'A protocol');
      assert.equal(record.members[0].oneLiner, 'new');
    },
  },
  {
    name: 'setAt rejects implicit parent creation and array growth',
    fn: async () => {
      const record = { members: [] };
      assert.throws(() => setAt(record, 'metadata.description', 'x'), /parent not found/);
      assert.throws(() => setAt(record, 'members[0]', { name: 'x' }), /array index out of range/);
    },
  },
];
