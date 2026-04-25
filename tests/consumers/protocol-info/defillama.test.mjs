import { strict as assert } from 'node:assert';
import { matchProtocol } from '../../../consumers/protocol-info/fetchers/defillama.mjs';

export const tests = [
  {
    name: 'matchProtocol picks exact name match over fuzzy',
    fn: async () => {
      const list = [
        { name: 'Pendle V2', slug: 'pendle-v2', tvl: 1 },
        { name: 'Pendle', slug: 'pendle', tvl: 100 },
        { name: 'Pendulum', slug: 'pendulum', tvl: 5 },
      ];
      const m = matchProtocol(list, 'Pendle');
      assert.equal(m.slug, 'pendle');
    },
  },
  {
    name: 'matchProtocol falls back to highest-TVL prefix match',
    fn: async () => {
      const list = [
        { name: 'Pendle V2', slug: 'pendle-v2', tvl: 100 },
        { name: 'PendleSomething', slug: 'pendle-something', tvl: 1 },
      ];
      const m = matchProtocol(list, 'Pendle');
      assert.equal(m.slug, 'pendle-v2');
    },
  },
  {
    name: 'matchProtocol returns null on no match',
    fn: async () => {
      const m = matchProtocol([{ name: 'Aave', slug: 'aave', tvl: 1 }], 'TotallyUnknownXYZ');
      assert.equal(m, null);
    },
  },
];
