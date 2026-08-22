import { strict as assert } from 'node:assert';
import {
  assertPublicResourceUrl,
  fetchPublicResource,
  isPublicNetworkAddress,
  readBoundedResponse,
} from '../../framework/resource-fetch.mjs';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function mockResponse({ status = 200, headers = {}, body = '' } = {}) {
  const bytes = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: new Response(bytes).body,
  };
}

export const tests = [
  {
    name: 'public resource boundary rejects literal, DNS, and IPv4-mapped private destinations',
    fn: async () => {
      assert.equal(isPublicNetworkAddress('8.8.8.8'), true);
      assert.equal(isPublicNetworkAddress('127.0.0.1'), false);
      assert.equal(isPublicNetworkAddress('::ffff:127.0.0.1'), false);
      await assert.rejects(
        () => assertPublicResourceUrl('https://127.0.0.1/admin'),
        /non-public address/,
      );
      await assert.rejects(
        () => assertPublicResourceUrl('https://assets.example/logo.png', {
          resolveHostname: async () => [{ address: '10.0.0.7', family: 4 }],
        }),
        /non-public address/,
      );
    },
  },
  {
    name: 'public resource boundary validates every redirect before following it',
    fn: async () => {
      let calls = 0;
      await assert.rejects(
        () => fetchPublicResource('https://public.example/logo.png', {
          resolveHostname: async (hostname) => hostname === 'metadata.internal.example'
            ? [{ address: '169.254.169.254', family: 4 }]
            : publicResolver(),
          pinnedTransport: true,
          fetchImpl: async () => {
            calls += 1;
            return mockResponse({ status: 302, headers: { location: 'https://metadata.internal.example/latest/meta-data' } });
          },
        }),
        /non-public address/,
      );
      assert.equal(calls, 1, 'private redirect destination must not be requested');
    },
  },
  {
    name: 'custom fetch injection fails closed without resolver and pinned transport guarantees',
    fn: async () => {
      let called = false;
      await assert.rejects(
        () => fetchPublicResource('https://public.example/logo.png', {
          fetchImpl: async () => { called = true; return mockResponse(); },
        }),
        /explicit resolver and pinned transport guarantee/,
      );
      assert.equal(called, false);
    },
  },
  {
    name: 'resource request deadline also bounds a custom resolver that ignores abort',
    fn: async () => {
      const controller = new AbortController();
      const timeoutError = new Error('resolver deadline reached');
      const timeout = setTimeout(() => controller.abort(timeoutError), 10);
      let fetched = false;
      try {
        await assert.rejects(
          () => fetchPublicResource('https://public.example/logo.png', {
            resolveHostname: async () => new Promise(() => {}),
            pinnedTransport: true,
            fetchImpl: async () => { fetched = true; return mockResponse(); },
            requestInit: { signal: controller.signal },
          }),
          /resolver deadline reached/,
        );
      } finally {
        clearTimeout(timeout);
      }
      assert.equal(fetched, false);
    },
  },
  {
    name: 'resource fetch cancels a redirect body when the redirect is rejected',
    fn: async () => {
      let canceled = false;
      await assert.rejects(
        () => fetchPublicResource('https://public.example/logo.png', {
          resolveHostname: publicResolver,
          pinnedTransport: true,
          fetchImpl: async () => ({
            ok: false,
            status: 302,
            headers: { get: () => null },
            body: new ReadableStream({ cancel() { canceled = true; } }),
          }),
        }),
        /no Location header/,
      );
      assert.equal(canceled, true);
    },
  },
  {
    name: 'bounded response reader stops streamed bodies above the configured limit',
    fn: async () => {
      const response = new Response(new Uint8Array(129), {
        headers: { 'content-type': 'image/png' },
      });
      await assert.rejects(
        () => readBoundedResponse(response, { maxBytes: 128, label: 'logo asset' }),
        /too large/,
      );
    },
  },
  {
    name: 'bounded response reader cancels a declared oversized body before rejecting it',
    fn: async () => {
      let canceled = false;
      const body = new ReadableStream({
        cancel() { canceled = true; },
      });
      await assert.rejects(
        () => readBoundedResponse({
          headers: { get: (name) => name.toLowerCase() === 'content-length' ? '129' : null },
          body,
        }, { maxBytes: 128, label: 'logo asset' }),
        /too large/,
      );
      assert.equal(canceled, true);
    },
  },
  {
    name: 'bounded response reader refuses unstreamed bodies instead of buffering them first',
    fn: async () => {
      let buffered = false;
      await assert.rejects(
        () => readBoundedResponse({
          headers: { get: () => null },
          arrayBuffer: async () => { buffered = true; return Buffer.alloc(1024); },
        }, { maxBytes: 128, label: 'report' }),
        /no streaming body/,
      );
      assert.equal(buffered, false);
    },
  },
  {
    name: 'ordinary public redirects and bounded bodies remain supported',
    fn: async () => {
      const calls = [];
      const { response, redirects } = await fetchPublicResource('https://public.example/start', {
        resolveHostname: publicResolver,
        pinnedTransport: true,
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          if (url.endsWith('/start')) {
            return mockResponse({ status: 301, headers: { location: '/logo.png' } });
          }
          return mockResponse({ status: 200, headers: { 'content-type': 'image/png' }, body: 'small-image' });
        },
      });
      assert.equal(redirects, 1);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].options.redirect, 'manual');
      assert.deepEqual(calls[0].options.validatedAddresses, [{ address: '93.184.216.34', family: 4 }]);
      assert.equal((await readBoundedResponse(response, { maxBytes: 64 })).toString(), 'small-image');
    },
  },
  {
    name: 'cross-origin redirects do not forward authorization credentials',
    fn: async () => {
      const calls = [];
      await fetchPublicResource('https://avatars.example/start', {
        resolveHostname: publicResolver,
        pinnedTransport: true,
        requestInit: { headers: { 'x-api-key': 'secret', 'user-agent': 'protocol-info-test' } },
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          if (url.includes('avatars.example')) {
            return mockResponse({ status: 302, headers: { location: 'https://cdn.example/logo.png' } });
          }
          return mockResponse({ status: 200, headers: { 'content-type': 'image/png' }, body: 'image' });
        },
      });
      assert.equal(calls[0].options.headers['x-api-key'], 'secret');
      assert.equal(calls[1].options.headers['x-api-key'], undefined);
      assert.equal(calls[1].options.headers['user-agent'], 'protocol-info-test');
    },
  },
];
