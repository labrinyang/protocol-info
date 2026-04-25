import { strict as assert } from 'node:assert';
import fetch, { search } from '../../../consumers/protocol-info/fetchers/rootdata.mjs';

export const tests = [
  {
    name: 'fetcher returns ok:false when ROOTDATA_API_KEY missing',
    fn: async () => {
      const result = await fetch({
        slug: 'pendle', displayName: 'Pendle', hints: '',
        env: {}, logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(result.name, 'rootdata');
      assert.equal(result.ok, false);
      assert.match(result.error, /ROOTDATA_API_KEY/);
    },
  },
  {
    name: 'fetcher result has expected envelope shape',
    fn: async () => {
      const result = await fetch({
        slug: 'pendle', displayName: 'Pendle', hints: '',
        env: {}, logger: { info: () => {}, warn: () => {} },
      });
      assert.ok('name' in result);
      assert.ok('ok' in result);
      assert.ok('cost_usd' in result);
      assert.ok('fetched_at' in result);
    },
  },
  {
    name: 'search channel returns ok:false when ROOTDATA_API_KEY missing',
    fn: async () => {
      const result = await search({
        query: 'Pendle founder',
        type: 'person',
        env: {},
        logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(result.channel, 'rootdata');
      assert.equal(result.ok, false);
      assert.deepEqual(result.results, []);
    },
  },
];
