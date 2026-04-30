import { strict as assert } from 'node:assert';
import fetch, {
  extractProviderLogoUrl,
  rootDataApiKeysFromEnv,
  search,
} from '../../../consumers/protocol-info/fetchers/rootdata.mjs';

function rootdataResponse({ ok = true, status = 200, body }) {
  const raw = JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => raw,
    json: async () => body,
  };
}

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
  {
    name: 'rootDataApiKeysFromEnv accepts plural, comma-separated, and numbered keys',
    fn: async () => {
      assert.deepEqual(rootDataApiKeysFromEnv({
        ROOTDATA_API_KEYS: 'a, b\nc',
        ROOTDATA_API_KEY: 'b',
        ROOTDATA_API_KEY_2: 'd;e',
        ROOTDATA_API_KEY_1: 'a',
      }), ['a', 'b', 'c', 'd', 'e']);
    },
  },
  {
    name: 'search randomizes key start and falls back across RootData key pool',
    fn: async () => {
      const calls = [];
      const result = await search({
        query: 'Pendle',
        type: 'project',
        env: { ROOTDATA_API_KEYS: 'bad,good' },
        random: () => 0,
        fetchImpl: async (_url, opts) => {
          const key = opts.headers.apikey;
          calls.push(key);
          if (key === 'bad') {
            return rootdataResponse({
              ok: false,
              status: 429,
              body: { result: 429, message: 'rate limited' },
            });
          }
          return rootdataResponse({
            body: { result: 200, data: [{ name: 'Pendle', id: 1 }] },
          });
        },
        logger: { warn: () => {} },
      });
      assert.deepEqual(calls, ['bad', 'good']);
      assert.equal(result.ok, true);
      assert.deepEqual(result.results, [{ name: 'Pendle', id: 1 }]);
    },
  },
  {
    name: 'extractProviderLogoUrl uses only RootData logo field',
    fn: async () => {
      assert.equal(extractProviderLogoUrl({ logo: 'https://cdn.rootdata.com/protocol/pendle.png' }), 'https://cdn.rootdata.com/protocol/pendle.png');
      assert.equal(extractProviderLogoUrl({ logo: 'http://example.com/insecure.png', logo_url: 'https://example.com/secure.png' }), null);
      assert.equal(extractProviderLogoUrl({ image: 'https://example.com/image.png', avatar: 'https://example.com/avatar.png' }), null);
      assert.equal(extractProviderLogoUrl({ logo: 'not-url' }), null);
    },
  },
];
