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
  {
    name: 'wraps thrown fetcher.search errors as ok:false results without aborting',
    fn: async () => {
      const fetchers = [
        { name: 'flaky', search: async () => { throw new Error('boom'); } },
        { name: 'good', search: async ({ query }) => ({ channel: 'good', query, ok: true, results: [{ id: 1 }] }) },
      ];
      const out = await runSearchRequests({
        requests: [
          { channel: 'flaky', type: 'project', query: 'x', reason: 'r1' },
          { channel: 'good',  type: 'project', query: 'y', reason: 'r2' },
        ],
        fetchers,
        maxQueries: 4,
        env: {},
        logger: { warn: () => {} },
        round: 2,
      });
      assert.equal(out.length, 2);
      assert.equal(out[0].ok, false);
      assert.equal(out[0].channel, 'flaky');
      assert.match(out[0].error, /boom/);
      assert.equal(out[1].ok, true);
      assert.deepEqual(out[1].results, [{ id: 1 }]);
    },
  },
];
