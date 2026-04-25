import { strict as assert } from 'node:assert';
import { runSearchRequests } from '../../framework/search-channel.mjs';

export const tests = [
  {
    name: 'runs approved search requests through fetcher search export',
    fn: async () => {
      const fetchers = [{
        name: 'rootdata',
        search: async ({ query, type }) => ({ channel: 'rootdata', query, type, ok: true, results: [{ id: 1 }] }),
      }];
      const out = await runSearchRequests({
        requests: [{ channel: 'rootdata', type: 'person', query: 'Pendle founder', reason: 'team verification' }],
        fetchers,
        maxQueries: 4,
        env: {},
        logger: console,
        round: 2,
      });
      assert.equal(out.length, 1);
      assert.equal(out[0].channel, 'rootdata');
      assert.deepEqual(out[0].results, [{ id: 1 }]);
    },
  },
  {
    name: 'drops unknown channels and caps query count',
    fn: async () => {
      const out = await runSearchRequests({
        requests: [
          { channel: 'unknown', type: 'project', query: 'x' },
          { channel: 'rootdata', type: 'project', query: 'y' },
        ],
        fetchers: [{ name: 'rootdata', search: async ({ query }) => ({ channel: 'rootdata', query, ok: true, results: [] }) }],
        maxQueries: 1,
        env: {},
        logger: console,
        round: 2,
      });
      assert.equal(out.length, 0);
    },
  },
];
