import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import normalizeLogoAssets, {
  rehostLogoAsset,
} from '../../../consumers/protocol-info/normalizers/logo-assets.mjs';
import {
  cleanupCreatedLogoAssets,
  LOGO_CDN_BASE,
  logoAssetDigest,
  readLogoAssetGeneration,
  withLogoAssetLock,
  writeLogoAssetGeneration,
} from '../../../framework/logo-assets.mjs';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function normalize(options) {
  if (!options.fetchImage || options.fetchImage === globalThis.fetch) return normalizeLogoAssets(options);
  return normalizeLogoAssets({
    ...options,
    resolveHostname: options.resolveHostname || publicResolver,
    pinnedTransport: true,
  });
}

async function tempOut() {
  return mkdtemp(join(tmpdir(), 'pi-logo-assets-'));
}

function imageBytes(contentType, payload = 'image') {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (contentType === 'image/png') {
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bytes]);
  }
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') {
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), bytes]);
  }
  if (contentType === 'image/webp') {
    return Buffer.concat([Buffer.from('RIFF0000WEBP'), bytes]);
  }
  return bytes;
}

function streamingBody(bytes) {
  return new Response(bytes).body;
}

async function storedImagePayload(path) {
  const bytes = await readFile(path);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return bytes.subarray(8).toString();
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return bytes.subarray(3).toString();
  }
  return bytes.toString();
}

function fakeImageFetch({ contentType = 'image/png', bytes = 'image' } = {}) {
  const calls = [];
  const fetchImage = async (url, options = undefined) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
      body: streamingBody(imageBytes(contentType, bytes)),
    };
  };
  return { fetchImage, calls };
}

function conditionalImageFetch(handler) {
  const calls = [];
  const fetchImage = async (url, options = undefined) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { fetchImage, calls };
}

function baseRecord(extra = {}) {
  return {
    slug: 'pendle',
    provider: 'pendle',
    providerLogoUrl: null,
    displayName: 'Pendle',
    members: [],
    audits: { items: [] },
    ...extra,
  };
}

export const tests = [
  {
    name: 'providerLogoUrl is filled from RootData, downloaded, and not re-fetched',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = fakeImageFetch();
      const evidence = { rootdata: { provider_logo_url: 'https://cdn.rootdata.com/project/pendle.png' } };
      const createdLogoAssetPaths = [];

      const first = await normalize({ record: baseRecord(), evidence, outputRoot, fetchImage, createdLogoAssetPaths });
      assert.equal(first.record.providerLogoUrl, `${LOGO_CDN_BASE}/protocol-logo/pendle.png`);
      assert.equal(existsSync(join(outputRoot, 'protocol-logo', 'pendle.png')), true);
      assert.equal(calls.length, 1);
      assert.equal(createdLogoAssetPaths[0].relPath, 'protocol-logo/pendle.png');
      assert.match(createdLogoAssetPaths[0].writtenSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(first.record).slice(0, 3), ['slug', 'provider', 'providerLogoUrl']);

      const second = await normalize({ record: first.record, evidence, outputRoot, fetchImage });
      assert.equal(second.record.providerLogoUrl, first.record.providerLogoUrl);
      assert.equal(calls.length, 1);
    },
  },
  {
    name: 'provider logo falls back to paid Unavatar from verified provider X link',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = conditionalImageFetch(async (url, options) => {
        if (url.includes('cdn.rootdata.com')) {
          return {
            ok: false,
            status: 404,
            headers: { get: () => null },
            arrayBuffer: async () => Buffer.from(''),
          };
        }
        assert.equal(options.headers['x-api-key'], 'paid-key');
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
          body: streamingBody(imageBytes('image/png', 'unavatar-provider')),
        };
      });
      const evidence = {
        rootdata: {
          provider_logo_url: 'https://cdn.rootdata.com/project/terminal.png',
          validated_overrides: { providerXLink: 'https://x.com/Terminal_fi' },
        },
      };

      const out = await normalize({
        record: baseRecord({ slug: 'terminal', provider: 'terminal', displayName: 'Terminal' }),
        evidence,
        outputRoot,
        fetchImage,
        env: { UNAVATAR_API_KEY: 'paid-key' },
      });

      assert.equal(out.record.providerLogoUrl, `${LOGO_CDN_BASE}/protocol-logo/terminal.png`);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, 'https://unavatar.io/x/Terminal_fi?fallback=false');
      assert.equal(await storedImagePayload(join(outputRoot, 'protocol-logo', 'terminal.png')), 'unavatar-provider');
      assert.match(out.changes[0].reason, /provider_logo_rehosted_via_unavatar_fallback/);
    },
  },
  {
    name: 'paid Unavatar member avatar sources are downloaded with x-api-key',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = fakeImageFetch({ contentType: 'image/png' });
      const record = baseRecord({
        members: [{ memberName: '0xngmi', avatarUrl: 'https://unavatar.io/x/0xngmi?fallback=false' }],
      });

      const out = await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage,
        env: { UNAVATAR_API_KEY: 'paid-key' },
      });
      assert.equal(out.record.members[0].avatarUrl, `${LOGO_CDN_BASE}/protocol-member-logo/pendle-0xngmi.png`);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://unavatar.io/x/0xngmi?fallback=false');
      assert.equal(calls[0].options.headers['x-api-key'], 'paid-key');
    },
  },
  {
    name: 'member RootData image download failure falls back to paid Unavatar',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = conditionalImageFetch(async (url) => {
        if (url.includes('public.rootdata.com')) {
          throw new Error('TLS failed');
        }
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
          body: streamingBody(imageBytes('image/png', 'unavatar-image')),
        };
      });
      const record = baseRecord({
        members: [
          {
            memberName: 'TN Lee',
            avatarUrl: 'https://public.rootdata.com/images/b39/1712906040035.jpg',
            memberLink: { xLink: 'https://x.com/tn_pendle', linkedinLink: null },
          },
        ],
      });

      const out = await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage,
        env: { UNAVATAR_API_KEY: 'paid-key' },
      });
      assert.equal(out.record.members[0].avatarUrl, `${LOGO_CDN_BASE}/protocol-member-logo/pendle-tn-lee.png`);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, 'https://public.rootdata.com/images/b39/1712906040035.jpg');
      assert.equal(calls[1].url, 'https://unavatar.io/x/tn_pendle?fallback=false');
      assert.equal(calls[1].options.headers['x-api-key'], 'paid-key');
      assert.equal(await storedImagePayload(join(outputRoot, 'protocol-member-logo', 'pendle-tn-lee.png')), 'unavatar-image');
      assert.match(out.changes[0].reason, /member_logo_rehosted_via_unavatar_fallback/);
    },
  },
  {
    name: 'member Unavatar fallback tries LinkedIn after X source fails',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = conditionalImageFetch(async (url) => {
        if (url.includes('/x/')) {
          return {
            ok: false,
            status: 404,
            headers: { get: () => null },
            arrayBuffer: async () => Buffer.from(''),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
          body: streamingBody(imageBytes('image/png', 'linkedin-image')),
        };
      });
      const record = baseRecord({
        members: [
          {
            memberName: 'Srikumar Misra',
            avatarUrl: 'https://unavatar.io/x/srikumar?fallback=false',
            memberLink: {
              xLink: 'https://x.com/srikumar',
              linkedinLink: 'https://www.linkedin.com/in/srikumar-misra/',
            },
          },
        ],
      });

      const out = await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage,
        env: { UNAVATAR_API_KEY: 'paid-key' },
      });
      assert.equal(out.record.members[0].avatarUrl, `${LOGO_CDN_BASE}/protocol-member-logo/pendle-srikumar-misra.png`);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, 'https://unavatar.io/x/srikumar?fallback=false');
      assert.equal(calls[1].url, 'https://unavatar.io/linkedin/user:srikumar-misra?fallback=false');
      assert.equal(await storedImagePayload(join(outputRoot, 'protocol-member-logo', 'pendle-srikumar-misra.png')), 'linkedin-image');
    },
  },
  {
    name: 'member avatar source URL is downloaded into protocol-member-logo',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = fakeImageFetch({ contentType: 'image/jpeg' });
      const record = baseRecord({
        members: [{ memberName: 'Alice Liu', avatarUrl: 'https://cdn.rootdata.com/people/alice.jpg' }],
      });

      const out = await normalize({ record, evidence: {}, outputRoot, fetchImage });
      assert.equal(out.record.members[0].avatarUrl, `${LOGO_CDN_BASE}/protocol-member-logo/pendle-alice-liu.jpg`);
      assert.equal(await storedImagePayload(join(outputRoot, 'protocol-member-logo', 'pendle-alice-liu.jpg')), 'image');
      assert.equal(calls.length, 1);

      await normalize({ record: out.record, evidence: {}, outputRoot, fetchImage });
      assert.equal(calls.length, 1);
    },
  },
  {
    name: 'audit logos are reused from existing out records across protocols',
    fn: async () => {
      const outputRoot = await tempOut();
      await mkdir(join(outputRoot, 'audit-logo'), { recursive: true });
      await writeFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'cached');
      await mkdir(join(outputRoot, 'aave'), { recursive: true });
      await writeFile(join(outputRoot, 'aave', 'record.json'), JSON.stringify({
        audits: {
          items: [
            {
              auditor: 'OpenZeppelin',
              auditorLogoUrl: `${LOGO_CDN_BASE}/audit-logo/openzeppelin.png`,
            },
          ],
        },
      }));
      const { fetchImage, calls } = fakeImageFetch();
      const record = baseRecord({
        audits: { items: [{ auditor: 'OpenZeppelin', auditorLogoUrl: null }] },
      });

      const out = await normalize({ record, evidence: {}, outputRoot, fetchImage });
      assert.equal(out.record.audits.items[0].auditorLogoUrl, `${LOGO_CDN_BASE}/audit-logo/openzeppelin.png`);
      assert.equal(calls.length, 0);
    },
  },
  {
    name: 'audit logo cache uses canonical auditor aliases',
    fn: async () => {
      const outputRoot = await tempOut();
      await mkdir(join(outputRoot, 'audit-logo'), { recursive: true });
      await writeFile(join(outputRoot, 'audit-logo', 'ackee-blockchain.png'), 'cached');
      await mkdir(join(outputRoot, 'aave'), { recursive: true });
      await writeFile(join(outputRoot, 'aave', 'record.json'), JSON.stringify({
        audits: {
          items: [
            {
              auditor: 'Ackee Blockchain',
              auditorLogoUrl: `${LOGO_CDN_BASE}/audit-logo/ackee-blockchain.png`,
            },
          ],
        },
      }));
      const { fetchImage, calls } = fakeImageFetch();
      const record = baseRecord({
        audits: { items: [{ auditor: 'Ackee', auditorLogoUrl: null }] },
      });

      const out = await normalize({ record, evidence: {}, outputRoot, fetchImage });
      assert.equal(out.record.audits.items[0].auditorLogoUrl, `${LOGO_CDN_BASE}/audit-logo/ackee-blockchain.png`);
      assert.equal(calls.length, 0);
    },
  },
  {
    name: 'current audit logo value is preferred over older local cache when rehostable',
    fn: async () => {
      const outputRoot = await tempOut();
      await mkdir(join(outputRoot, 'audit-logo'), { recursive: true });
      await writeFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'old-cache');
      const { fetchImage, calls } = fakeImageFetch({ contentType: 'image/svg+xml', bytes: '<svg />' });
      const record = baseRecord({
        audits: {
          items: [
            {
              auditor: 'OpenZeppelin',
              auditorLogoUrl: 'https://manual.example/openzeppelin-correct.svg',
            },
          ],
        },
      });

      const out = await normalize({ record, evidence: {}, outputRoot, fetchImage });
      assert.equal(out.record.audits.items[0].auditorLogoUrl, `${LOGO_CDN_BASE}/audit-logo/openzeppelin.svg`);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://manual.example/openzeppelin-correct.svg');
      assert.equal(await readFile(join(outputRoot, 'audit-logo', 'openzeppelin.svg'), 'utf8'), '<svg />');
    },
  },
  {
    name: 'current external audit logo overwrites same-name cached file',
    fn: async () => {
      const outputRoot = await tempOut();
      await mkdir(join(outputRoot, 'audit-logo'), { recursive: true });
      await writeFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'old-cache');
      const { fetchImage, calls } = fakeImageFetch({ contentType: 'image/png', bytes: 'manual-fix' });
      const record = baseRecord({
        audits: {
          items: [
            {
              auditor: 'OpenZeppelin',
              auditorLogoUrl: 'https://manual.example/openzeppelin-correct.png',
            },
          ],
        },
      });

      const out = await normalize({ record, evidence: {}, outputRoot, fetchImage });
      assert.equal(out.record.audits.items[0].auditorLogoUrl, `${LOGO_CDN_BASE}/audit-logo/openzeppelin.png`);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://manual.example/openzeppelin-correct.png');
      assert.equal(await storedImagePayload(join(outputRoot, 'audit-logo', 'openzeppelin.png')), 'manual-fix');
    },
  },
  {
    name: 'audit logos are filled from exact RootData project matches and reused locally',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = fakeImageFetch();
      const searchCalls = [];
      const searchRootData = async (args) => {
        searchCalls.push(args);
        return {
          ok: true,
          results: [
            { name: 'OpenZeppelin', logo: 'https://cdn.rootdata.com/project/openzeppelin.png' },
          ],
        };
      };
      const record = baseRecord({
        audits: { items: [{ auditor: 'OpenZeppelin', auditorLogoUrl: null }] },
      });

      const out = await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage,
        searchRootData,
        env: { ROOTDATA_API_KEY: 'test-key' },
      });
      assert.equal(out.record.audits.items[0].auditorLogoUrl, `${LOGO_CDN_BASE}/audit-logo/openzeppelin.png`);
      assert.equal(await storedImagePayload(join(outputRoot, 'audit-logo', 'openzeppelin.png')), 'image');
      assert.equal(searchCalls.length, 1);
      assert.equal(searchCalls[0].query, 'OpenZeppelin');
      assert.equal(searchCalls[0].type, 'project');
      assert.equal(calls.length, 1);

      await normalize({
        record: out.record,
        evidence: {},
        outputRoot,
        fetchImage,
        searchRootData,
        env: { ROOTDATA_API_KEY: 'test-key' },
      });
      assert.equal(searchCalls.length, 1);
      assert.equal(calls.length, 1);
    },
  },
  {
    name: 'audit RootData logo search requires an exact entity-name match',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = fakeImageFetch();
      const searchRootData = async () => ({
        ok: true,
        results: [
          { name: 'Open Campus', logo: 'https://cdn.rootdata.com/project/open-campus.png' },
        ],
      });
      const record = baseRecord({
        audits: { items: [{ auditor: 'OpenZeppelin', auditorLogoUrl: null }] },
      });

      const out = await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage,
        searchRootData,
        env: { ROOTDATA_API_KEY: 'test-key' },
      });
      assert.equal(out.record.audits.items[0].auditorLogoUrl, null);
      assert.equal(calls.length, 0);
      assert.equal(out.gaps.length, 1);
      assert.match(out.gaps[0].reason, /rootdata_no_exact_logo_match/);
    },
  },
  {
    name: 'audit RootData exact match can use GitHub owner via paid Unavatar fallback',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = fakeImageFetch();
      const searchRootData = async () => ({
        ok: true,
        results: [
          { name: 'Trail of Bits', github: 'https://github.com/trailofbits' },
        ],
      });
      const record = baseRecord({
        audits: { items: [{ auditor: 'Trail of Bits', auditorLogoUrl: null }] },
      });

      const out = await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage,
        searchRootData,
        env: { ROOTDATA_API_KEY: 'test-key', UNAVATAR_API_KEY: 'paid-key' },
      });
      assert.equal(out.record.audits.items[0].auditorLogoUrl, `${LOGO_CDN_BASE}/audit-logo/trail-of-bits.png`);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://unavatar.io/github/trailofbits?fallback=false');
      assert.equal(calls[0].options.headers['x-api-key'], 'paid-key');
    },
  },
  {
    name: 'unstable pbs.twimg.com logos are rejected and nulled',
    fn: async () => {
      const outputRoot = await tempOut();
      const { fetchImage, calls } = fakeImageFetch();
      const record = baseRecord({
        members: [{ memberName: 'Alice Liu', avatarUrl: 'https://pbs.twimg.com/profile_images/x.jpg' }],
      });

      const out = await normalize({ record, evidence: {}, outputRoot, fetchImage });
      assert.equal(out.record.members[0].avatarUrl, null);
      assert.equal(out.gaps.length, 1);
      assert.match(out.gaps[0].reason, /twimg_unstable/);
      assert.equal(calls.length, 0);
    },
  },
  {
    name: 'logo rehosting rejects private redirects before requesting the destination',
    fn: async () => {
      const outputRoot = await tempOut();
      let calls = 0;
      const out = await normalize({
        record: baseRecord({ providerLogoUrl: 'https://public.example/logo.png' }),
        evidence: {},
        outputRoot,
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImage: async () => {
          calls += 1;
          return {
            ok: false,
            status: 302,
            headers: {
              get: (name) => name.toLowerCase() === 'location'
                ? 'https://127.0.0.1/admin'
                : null,
            },
          };
        },
      });
      assert.equal(calls, 1);
      assert.equal(out.record.providerLogoUrl, null);
      assert.match(out.changes[0].reason, /non-public address/);
    },
  },
  {
    name: 'logo rehosting rejects an unpinned custom fetch before it is called',
    fn: async () => {
      const outputRoot = await tempOut();
      let called = false;
      const result = await rehostLogoAsset({
        sourceUrl: 'https://assets.example/logo.png',
        outputRoot,
        folder: 'protocol-logo',
        nameBase: 'pendle',
        fetchImage: async () => { called = true; throw new Error('must not run'); },
      });
      assert.equal(result.url, null);
      assert.match(result.reason, /explicit resolver and pinned transport guarantee/);
      assert.equal(called, false);
    },
  },
  {
    name: 'logo download deadline bounds a custom transport that ignores abort',
    fn: async () => {
      const outputRoot = await tempOut();
      const startedAt = Date.now();
      const result = await rehostLogoAsset({
        sourceUrl: 'https://assets.example/logo.png',
        outputRoot,
        folder: 'protocol-logo',
        nameBase: 'pendle',
        fetchImage: async () => new Promise(() => {}),
        resolveHostname: publicResolver,
        pinnedTransport: true,
        timeoutMs: 20,
      });
      assert.equal(result.url, null);
      assert.match(result.reason, /timed out/);
      assert.ok(Date.now() - startedAt < 1_000, 'deadline should not wait for the custom transport');
    },
  },
  {
    name: 'logo download deadline cancels a response that arrives after timeout',
    fn: async () => {
      const outputRoot = await tempOut();
      let canceled = false;
      const result = await rehostLogoAsset({
        sourceUrl: 'https://assets.example/logo.png',
        outputRoot,
        folder: 'protocol-logo',
        nameBase: 'pendle',
        fetchImage: async () => new Promise((resolveResponse) => {
          setTimeout(() => resolveResponse({
            ok: true,
            status: 200,
            headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
            body: new ReadableStream({ cancel() { canceled = true; } }),
          }), 40);
        }),
        resolveHostname: publicResolver,
        pinnedTransport: true,
        timeoutMs: 10,
      });
      assert.equal(result.url, null);
      assert.match(result.reason, /timed out/);
      await new Promise((resolveWait) => setTimeout(resolveWait, 60));
      assert.equal(canceled, true);
    },
  },
  {
    name: 'logo download deadline cancels a stalled streaming body',
    fn: async () => {
      const outputRoot = await tempOut();
      let canceled = false;
      const result = await rehostLogoAsset({
        sourceUrl: 'https://assets.example/logo.png',
        outputRoot,
        folder: 'protocol-logo',
        nameBase: 'pendle',
        fetchImage: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
          body: new ReadableStream({ cancel() { canceled = true; } }),
        }),
        resolveHostname: publicResolver,
        pinnedTransport: true,
        timeoutMs: 10,
      });
      assert.equal(result.url, null);
      assert.match(result.reason, /timed out/);
      assert.equal(canceled, true);
    },
  },
  {
    name: 'logo rejection does not await a non-cooperative body cancellation',
    fn: async () => {
      const outputRoot = await tempOut();
      const startedAt = Date.now();
      const result = await rehostLogoAsset({
        sourceUrl: 'https://assets.example/logo.png',
        outputRoot,
        folder: 'protocol-logo',
        nameBase: 'pendle',
        fetchImage: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : null },
          body: { cancel: () => new Promise(() => {}) },
        }),
        resolveHostname: publicResolver,
        pinnedTransport: true,
        timeoutMs: 10,
      });
      assert.equal(result.url, null);
      assert.match(result.reason, /unsupported_content_type/);
      assert.ok(Date.now() - startedAt < 500, 'rejection must not await a hostile cancel implementation');
    },
  },
  {
    name: 'logo rehosting cancels a response rejected by content type',
    fn: async () => {
      const outputRoot = await tempOut();
      let canceled = false;
      const result = await rehostLogoAsset({
        sourceUrl: 'https://assets.example/logo.png',
        outputRoot,
        folder: 'protocol-logo',
        nameBase: 'pendle',
        fetchImage: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : null },
          body: new ReadableStream({ cancel() { canceled = true; } }),
        }),
        resolveHostname: publicResolver,
        pinnedTransport: true,
      });
      assert.equal(result.url, null);
      assert.match(result.reason, /unsupported_content_type/);
      assert.equal(canceled, true);
    },
  },
  {
    name: 'logo rehosting rejects non-image and oversized responses without writing files',
    fn: async () => {
      const outputRoot = await tempOut();
      let bodyRead = false;
      const nonImage = await normalize({
        record: baseRecord({ providerLogoUrl: 'https://assets.example/not-image.png' }),
        evidence: {},
        outputRoot,
        fetchImage: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : null },
          arrayBuffer: async () => { bodyRead = true; return Buffer.from('<html>not an image</html>'); },
        }),
      });
      assert.equal(nonImage.record.providerLogoUrl, null);
      assert.equal(bodyRead, false, 'unsupported content type must be rejected before reading its body');

      const mislabeled = await normalize({
        record: baseRecord({ providerLogoUrl: 'https://assets.example/fake.png' }),
        evidence: {},
        outputRoot,
        fetchImage: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
          body: streamingBody(Buffer.from('<html>still not an image</html>')),
        }),
      });
      assert.equal(mislabeled.record.providerLogoUrl, null);
      assert.match(mislabeled.changes[0].reason, /invalid_image_bytes/);

      const oversized = await normalize({
        record: baseRecord({ providerLogoUrl: 'https://assets.example/huge.png' }),
        evidence: {},
        outputRoot,
        fetchImage: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (name) => {
              if (name.toLowerCase() === 'content-type') return 'image/png';
              if (name.toLowerCase() === 'content-length') return String(6 * 1024 * 1024);
              return null;
            },
          },
          arrayBuffer: async () => { bodyRead = true; return Buffer.alloc(0); },
        }),
      });
      assert.equal(oversized.record.providerLogoUrl, null);
      assert.match(oversized.changes[0].reason, /too large/);
      assert.equal(existsSync(join(outputRoot, 'protocol-logo', 'pendle.png')), false);
    },
  },
  {
    name: 'logo rehosting refuses a symlinked shared asset folder',
    fn: async () => {
      const outputRoot = await tempOut();
      const outside = await mkdtemp(join(tmpdir(), 'pi-logo-outside-'));
      await symlink(outside, join(outputRoot, 'protocol-logo'));
      const { fetchImage, calls } = fakeImageFetch();
      const out = await normalize({
        record: baseRecord({ providerLogoUrl: 'https://assets.example/pendle.png' }),
        evidence: {},
        outputRoot,
        fetchImage,
      });
      assert.equal(out.record.providerLogoUrl, null);
      assert.match(out.changes[0].reason, /unsafe_asset_folder_symlink/);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(join(outside, 'pendle.png')), false);
    },
  },
  {
    name: 'failed transaction restores a pre-existing shared audit logo after replacement',
    fn: async () => {
      const outputRoot = await tempOut();
      await mkdir(join(outputRoot, 'audit-logo'), { recursive: true });
      await writeFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'pre-existing-logo');
      const createdLogoAssetPaths = [];
      const { fetchImage } = fakeImageFetch({ bytes: 'replacement-logo' });
      let registeredBeforeWrite = false;

      await normalize({
        record: baseRecord({
          audits: {
            items: [{
              auditor: 'OpenZeppelin',
              auditorLogoUrl: 'https://manual.example/openzeppelin.png',
            }],
          },
        }),
        evidence: {},
        outputRoot,
        fetchImage,
        createdLogoAssetPaths,
        registerLogoAssetMutation: async (mutation) => {
          assert.equal(await readFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'utf8'), 'pre-existing-logo');
          createdLogoAssetPaths.push(mutation);
          registeredBeforeWrite = true;
        },
      });
      assert.equal(registeredBeforeWrite, true);
      assert.equal(await storedImagePayload(join(outputRoot, 'audit-logo', 'openzeppelin.png')), 'replacement-logo');
      assert.equal(typeof createdLogoAssetPaths[0], 'object');

      await cleanupCreatedLogoAssets(outputRoot, createdLogoAssetPaths);
      assert.equal(await readFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'utf8'), 'pre-existing-logo');
    },
  },
  {
    name: 'failed rollback cannot overwrite a newer shared logo mutation',
    fn: async () => {
      const outputRoot = await tempOut();
      const assetPath = join(outputRoot, 'audit-logo', 'openzeppelin.png');
      const firstMutations = [];
      const secondMutations = [];
      const record = baseRecord({
        audits: {
          items: [{
            auditor: 'OpenZeppelin',
            auditorLogoUrl: 'https://manual.example/openzeppelin.png',
          }],
        },
      });

      await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage: fakeImageFetch({ bytes: 'identical-write' }).fetchImage,
        createdLogoAssetPaths: firstMutations,
      });
      await normalize({
        record,
        evidence: {},
        outputRoot,
        fetchImage: fakeImageFetch({ bytes: 'identical-write' }).fetchImage,
        createdLogoAssetPaths: secondMutations,
      });

      await cleanupCreatedLogoAssets(outputRoot, firstMutations);
      assert.equal(await storedImagePayload(assetPath), 'identical-write');
      assert.equal(firstMutations[0].writtenSha256, secondMutations[0].writtenSha256);
      assert.notEqual(firstMutations[0].generation, secondMutations[0].generation);

      await cleanupCreatedLogoAssets(outputRoot, secondMutations);
      assert.equal(existsSync(assetPath), false);
    },
  },
  {
    name: 'successful reuse transfers ownership and cascades dual-failure rollback',
    fn: async () => {
      const outputRoot = await tempOut();
      const firstMutations = [];
      const secondMutations = [];
      const evidence = { rootdata: { provider_logo_url: 'https://assets.example/pendle.png' } };
      const first = await normalize({
        record: baseRecord(),
        evidence,
        outputRoot,
        fetchImage: fakeImageFetch({ bytes: 'shared-write' }).fetchImage,
        createdLogoAssetPaths: firstMutations,
      });
      let refetched = false;
      await normalize({
        record: first.record,
        evidence,
        outputRoot,
        fetchImage: async () => { refetched = true; throw new Error('must reuse'); },
        resolveHostname: publicResolver,
        pinnedTransport: true,
        createdLogoAssetPaths: secondMutations,
      });

      const assetPath = join(outputRoot, 'protocol-logo', 'pendle.png');
      assert.equal(refetched, false);
      assert.equal(secondMutations[0].preserveOnRollback, true);
      assert.notEqual(firstMutations[0].generation, secondMutations[0].generation);
      await cleanupCreatedLogoAssets(outputRoot, firstMutations);
      assert.equal(await storedImagePayload(assetPath), 'shared-write');

      await cleanupCreatedLogoAssets(outputRoot, secondMutations);
      assert.equal(existsSync(assetPath), false);
      assert.equal((await readdir(outputRoot)).some((name) => name.includes('logo-asset')), false);
    },
  },
  {
    name: 'rollback repairs generation state after a crash before atomic publish',
    fn: async () => {
      const outputRoot = await tempOut();
      const relPath = 'audit-logo/openzeppelin.png';
      const assetPath = join(outputRoot, relPath);
      await mkdir(join(outputRoot, 'audit-logo'), { recursive: true });
      await writeFile(assetPath, 'pre-existing-logo');
      const generation = 'crash-window-generation';
      await writeLogoAssetGeneration(outputRoot, relPath, generation);

      await cleanupCreatedLogoAssets(outputRoot, [{
        relPath,
        generation,
        previousGeneration: null,
        writtenSha256: logoAssetDigest(imageBytes('image/png', 'replacement')),
        restoreBase64: Buffer.from('pre-existing-logo').toString('base64'),
      }]);

      assert.equal(await readFile(assetPath, 'utf8'), 'pre-existing-logo');
      assert.equal(await readLogoAssetGeneration(outputRoot, relPath), null);
    },
  },
  {
    name: 'live lock identity is stable across contender timezones',
    fn: async () => {
      const { spawn } = await import('node:child_process');
      const { rm } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const outputRoot = await tempOut();
      const relPath = 'audit-logo/openzeppelin.png';
      const moduleUrl = pathToFileURL(resolve('framework/logo-assets.mjs')).href;
      const childSource = `
        import { withLogoAssetLock } from ${JSON.stringify(moduleUrl)};
        const [outputRoot, relPath] = process.argv.slice(1);
        await withLogoAssetLock(outputRoot, relPath, async () => {
          process.stdout.write('LOCKED\\n');
          await new Promise(() => { setInterval(() => {}, 1_000); });
        });
      `;
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        childSource,
        outputRoot,
        relPath,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TZ: 'UTC' },
      });
      let childStdout = '';
      let childStderr = '';
      child.stdout.on('data', (chunk) => { childStdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { childStderr += chunk.toString(); });
      const childExit = new Promise((resolveExit, rejectExit) => {
        child.on('error', rejectExit);
        child.on('exit', (code, signal) => resolveExit({ code, signal }));
      });
      const locked = new Promise((resolveLocked, rejectLocked) => {
        const poll = setInterval(() => {
          if (childStdout.includes('LOCKED\n')) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolveLocked();
          }
        }, 5);
        const timeout = setTimeout(() => {
          clearInterval(poll);
          rejectLocked(new Error(`cross-timezone child did not acquire lock: ${childStderr}`));
        }, 2_000);
      });
      const namespace = join(
        tmpdir(),
        'protocol-info-logo-assets',
        logoAssetDigest(Buffer.from(resolve(outputRoot))),
      );
      const originalTimezone = process.env.TZ;
      let waiter = null;
      let parentEntered = false;

      try {
        await locked;
        process.env.TZ = 'Asia/Singapore';
        waiter = withLogoAssetLock(outputRoot, relPath, async () => { parentEntered = true; });
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
        assert.equal(parentEntered, false);
        assert.equal(child.exitCode, null);

        child.kill('SIGKILL');
        const exited = await childExit;
        assert.equal(exited.signal, 'SIGKILL');
        await waiter;
        assert.equal(parentEntered, true);
      } finally {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        await childExit.catch(() => {});
        await waiter?.catch(() => {});
        await rm(namespace, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'SIGKILL owner recovery preserves mutual exclusion for racing logo lock waiters',
    fn: async () => {
      const { spawn } = await import('node:child_process');
      const { rm } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const outputRoot = await tempOut();
      const relPath = 'audit-logo/openzeppelin.png';
      const moduleUrl = pathToFileURL(resolve('framework/logo-assets.mjs')).href;
      const childSource = `
        import { withLogoAssetLock } from ${JSON.stringify(moduleUrl)};
        const [outputRoot, relPath] = process.argv.slice(1);
        await withLogoAssetLock(outputRoot, relPath, async () => {
          process.stdout.write('LOCKED\\n');
          await new Promise(() => { setInterval(() => {}, 1_000); });
        });
      `;
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        childSource,
        outputRoot,
        relPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let childStdout = '';
      let childStderr = '';
      child.stdout.on('data', (chunk) => { childStdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { childStderr += chunk.toString(); });
      const childExit = new Promise((resolveExit, rejectExit) => {
        child.on('error', rejectExit);
        child.on('exit', (code, signal) => resolveExit({ code, signal }));
      });
      const locked = new Promise((resolveLocked, rejectLocked) => {
        const poll = setInterval(() => {
          if (childStdout.includes('LOCKED\n')) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolveLocked();
          }
        }, 5);
        const timeout = setTimeout(() => {
          clearInterval(poll);
          rejectLocked(new Error(`child did not acquire lock: ${childStderr}`));
        }, 2_000);
      });

      const namespace = join(
        tmpdir(),
        'protocol-info-logo-assets',
        logoAssetDigest(Buffer.from(resolve(outputRoot))),
      );
      try {
        await locked;
        child.kill('SIGKILL');
        const exited = await childExit;
        assert.equal(exited.signal, 'SIGKILL');

        const events = [];
        let active = 0;
        let maxActive = 0;
        let releaseWinner;
        let announceWinner;
        const winnerEntered = new Promise((resolveWinner) => { announceWinner = resolveWinner; });
        const winnerGate = new Promise((resolveGate) => { releaseWinner = resolveGate; });
        let entryCount = 0;
        const contender = (label) => withLogoAssetLock(outputRoot, relPath, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          entryCount += 1;
          events.push(`${label}-enter`);
          if (entryCount === 1) {
            announceWinner(label);
            await winnerGate;
          }
          events.push(`${label}-exit`);
          active -= 1;
        });

        const startedAt = Date.now();
        const contenders = Promise.all([contender('a'), contender('b')]);
        const firstLabel = await winnerEntered;
        await new Promise((resolveWait) => setTimeout(resolveWait, 60));
        assert.equal(active, 1);
        assert.equal(entryCount, 1);
        releaseWinner();
        let completionTimer;
        try {
          await Promise.race([
            contenders,
            new Promise((_, reject) => {
              completionTimer = setTimeout(
                () => reject(new Error('recovered lock contenders did not finish under 5s')),
                4_500,
              );
            }),
          ]);
        } finally {
          clearTimeout(completionTimer);
        }

        assert.equal(maxActive, 1);
        assert.equal(entryCount, 2);
        assert.ok(Date.now() - startedAt < 5_000);
        assert.deepEqual(
          events,
          [`${firstLabel}-enter`, `${firstLabel}-exit`, `${firstLabel === 'a' ? 'b' : 'a'}-enter`, `${firstLabel === 'a' ? 'b' : 'a'}-exit`],
        );
      } finally {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        await childExit.catch(() => {});
        await rm(namespace, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'logo lock state failure aborts normalization instead of nulling the record logo',
    fn: async () => {
      const { rm } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const outputRoot = await tempOut();
      const relPath = 'protocol-logo/pendle.png';
      const namespace = join(
        tmpdir(),
        'protocol-info-logo-assets',
        logoAssetDigest(Buffer.from(resolve(outputRoot))),
      );
      const lockPath = join(
        namespace,
        'locks',
        `${logoAssetDigest(Buffer.from(relPath))}.lock`,
      );
      await mkdir(join(outputRoot, 'protocol-logo'), { recursive: true });
      await writeFile(join(outputRoot, relPath), 'committed-logo');
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
        pid: 999_999,
        token: '00000000-0000-4000-8000-000000000000',
      }));
      const record = baseRecord({
        providerLogoUrl: `${LOGO_CDN_BASE}/${relPath}`,
      });

      try {
        await assert.rejects(
          () => normalize({ record, evidence: {}, outputRoot }),
          (error) => error?.kind === 'logo_asset_lock_failed'
            && /incomplete logo asset lock owner/.test(error.message),
        );
        assert.equal(record.providerLogoUrl, `${LOGO_CDN_BASE}/${relPath}`);
        assert.equal(await readFile(join(outputRoot, relPath), 'utf8'), 'committed-logo');
      } finally {
        await rm(namespace, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'empty-directory and symlink logo locks fail closed without mutating record or asset',
    fn: async () => {
      const { rm } = await import('node:fs/promises');
      const { dirname, resolve } = await import('node:path');
      for (const malformedState of ['empty-directory', 'symlink']) {
        const outputRoot = await tempOut();
        const relPath = 'protocol-logo/pendle.png';
        const namespace = join(
          tmpdir(),
          'protocol-info-logo-assets',
          logoAssetDigest(Buffer.from(resolve(outputRoot))),
        );
        const lockPath = join(
          namespace,
          'locks',
          `${logoAssetDigest(Buffer.from(relPath))}.lock`,
        );
        const symlinkTarget = join(outputRoot, 'malformed-lock-target');
        await mkdir(join(outputRoot, 'protocol-logo'), { recursive: true });
        await writeFile(join(outputRoot, relPath), 'committed-logo');
        await mkdir(dirname(lockPath), { recursive: true });
        if (malformedState === 'empty-directory') {
          await mkdir(lockPath);
        } else {
          await mkdir(symlinkTarget);
          await symlink(symlinkTarget, lockPath, 'dir');
        }
        const record = baseRecord({
          providerLogoUrl: `${LOGO_CDN_BASE}/${relPath}`,
        });

        try {
          await assert.rejects(
            () => normalize({ record, evidence: {}, outputRoot }),
            (error) => error?.kind === 'logo_asset_lock_failed'
              && (malformedState === 'empty-directory'
                ? /incomplete logo asset lock owner/.test(error.message)
                : /unsafe logo asset lock path/.test(error.message)),
          );
          assert.equal(record.providerLogoUrl, `${LOGO_CDN_BASE}/${relPath}`);
          assert.equal(await readFile(join(outputRoot, relPath), 'utf8'), 'committed-logo');
        } finally {
          await rm(namespace, { recursive: true, force: true });
        }
      }
    },
  },
  {
    name: 'racing waiters recover a dead legacy lock into the no-replace file format',
    fn: async () => {
      const { execFileSync, spawn } = await import('node:child_process');
      const { lstat, rm } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const outputRoot = await tempOut();
      const relPath = 'audit-logo/openzeppelin.png';
      const token = '11111111-1111-4111-8111-111111111111';
      const namespace = join(
        tmpdir(),
        'protocol-info-logo-assets',
        logoAssetDigest(Buffer.from(resolve(outputRoot))),
      );
      const lockRoot = join(namespace, 'locks');
      const lockPath = join(lockRoot, `${logoAssetDigest(Buffer.from(relPath))}.lock`);
      const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1_000)'], {
        stdio: 'ignore',
      });
      const childExit = new Promise((resolveExit, rejectExit) => {
        child.on('error', rejectExit);
        child.on('exit', (code, signal) => resolveExit({ code, signal }));
      });

      try {
        await new Promise((resolveSpawn, rejectSpawn) => {
          child.once('spawn', resolveSpawn);
          child.once('error', rejectSpawn);
        });
        const processStartIdentity = `ps-lstart:${execFileSync(
          'ps',
          ['-o', 'lstart=', '-p', String(child.pid)],
          { encoding: 'utf8' },
        ).trim().replace(/\s+/g, ' ')}`;
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
          pid: child.pid,
          token,
          processStartIdentity,
        }));
        child.kill('SIGKILL');
        const exited = await childExit;
        assert.equal(exited.signal, 'SIGKILL');

        let active = 0;
        let maxActive = 0;
        let entryCount = 0;
        const contender = () => withLogoAssetLock(outputRoot, relPath, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          entryCount += 1;
          await new Promise((resolveWait) => setTimeout(resolveWait, 30));
          active -= 1;
        });
        await Promise.all([contender(), contender()]);
        assert.equal(entryCount, 2);
        assert.equal(maxActive, 1);
        assert.equal(existsSync(lockPath), false);
        const quarantinePath = `${lockPath}.orphan-${token}`;
        assert.equal((await lstat(quarantinePath)).isDirectory(), true);
        assert.equal(
          JSON.parse(await readFile(join(quarantinePath, 'owner.json'), 'utf8')).token,
          token,
        );
      } finally {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        await childExit.catch(() => {});
        await rm(namespace, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'legacy lock quarantine never replaces an existing empty directory or symlink',
    fn: async () => {
      const { lstat, rm } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const relPath = 'protocol-logo/pendle.png';
      const token = '22222222-2222-4222-8222-222222222222';
      const cases = await Promise.all(['empty-directory', 'symlink'].map(async (obstacle) => {
        const outputRoot = await tempOut();
        const namespace = join(
          tmpdir(),
          'protocol-info-logo-assets',
          logoAssetDigest(Buffer.from(resolve(outputRoot))),
        );
        const lockPath = join(
          namespace,
          'locks',
          `${logoAssetDigest(Buffer.from(relPath))}.lock`,
        );
        const quarantinePath = `${lockPath}.orphan-${token}`;
        const symlinkTarget = join(outputRoot, 'quarantine-target');
        const owner = {
          pid: process.pid,
          token,
          processStartIdentity: 'ps-lstart:definitely-stale-owner',
        };
        await mkdir(join(outputRoot, 'protocol-logo'), { recursive: true });
        await writeFile(join(outputRoot, relPath), 'committed-logo');
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner));
        if (obstacle === 'empty-directory') {
          await mkdir(quarantinePath);
        } else {
          await mkdir(symlinkTarget);
          await symlink(symlinkTarget, quarantinePath, 'dir');
        }
        return {
          obstacle,
          outputRoot,
          namespace,
          lockPath,
          quarantinePath,
          owner,
          record: baseRecord({ providerLogoUrl: `${LOGO_CDN_BASE}/${relPath}` }),
        };
      }));

      try {
        await Promise.all(cases.map(({ outputRoot, record }) => assert.rejects(
          () => normalize({ record, evidence: {}, outputRoot }),
          (error) => error?.kind === 'logo_asset_lock_failed',
        )));
        for (const state of cases) {
          assert.equal(state.record.providerLogoUrl, `${LOGO_CDN_BASE}/${relPath}`);
          assert.equal(await readFile(join(state.outputRoot, relPath), 'utf8'), 'committed-logo');
          assert.deepEqual(
            JSON.parse(await readFile(join(state.lockPath, 'owner.json'), 'utf8')),
            state.owner,
          );
          const obstacleInfo = await lstat(state.quarantinePath);
          assert.equal(
            state.obstacle === 'empty-directory'
              ? obstacleInfo.isDirectory()
              : obstacleInfo.isSymbolicLink(),
            true,
          );
        }
      } finally {
        await Promise.all(cases.map(({ namespace }) => rm(namespace, { recursive: true, force: true })));
      }
    },
  },
  {
    name: 'overlapping same-path logo locks serialize without removing their shared root',
    fn: async () => {
      const outputRoot = await tempOut();
      const relPath = 'audit-logo/openzeppelin.png';
      let enterFirst;
      let releaseFirst;
      const firstEntered = new Promise((resolveEntered) => { enterFirst = resolveEntered; });
      const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
      const events = [];
      const first = withLogoAssetLock(outputRoot, relPath, async () => {
        events.push('first-enter');
        enterFirst();
        await firstGate;
        events.push('first-exit');
      });
      await firstEntered;
      const second = withLogoAssetLock(outputRoot, relPath, async () => {
        events.push('second-enter');
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
      assert.deepEqual(events, ['first-enter']);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter']);
    },
  },
  {
    name: 'lock release failure preserves primitive and frozen operation failures',
    fn: async () => {
      const { rm } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const relPath = 'audit-logo/openzeppelin.png';
      const operationErrors = [
        'primitive operation failure',
        Object.freeze(new Error('frozen operation failure')),
      ];

      for (const operationError of operationErrors) {
        const outputRoot = await tempOut();
        const namespace = join(
          tmpdir(),
          'protocol-info-logo-assets',
          logoAssetDigest(Buffer.from(resolve(outputRoot))),
        );
        const lockPath = join(
          namespace,
          'locks',
          `${logoAssetDigest(Buffer.from(relPath))}.lock`,
        );
        try {
          await assert.rejects(
            () => withLogoAssetLock(outputRoot, relPath, async () => {
              await unlink(lockPath);
              await mkdir(lockPath);
              throw operationError;
            }),
            (error) => {
              assert.equal(error instanceof AggregateError, true);
              assert.equal(error.kind, 'logo_asset_lock_failed');
              assert.equal(error.errors[0], operationError);
              assert.equal(error.errors[1]?.kind, 'logo_asset_lock_failed');
              assert.match(error.errors[1].message, /failed to verify logo asset lock release/);
              return true;
            },
          );
        } finally {
          await rm(namespace, { recursive: true, force: true });
        }
      }
    },
  },
  {
    name: 'asset rollback refuses a swapped symlink restore target',
    fn: async () => {
      const outputRoot = await tempOut();
      const outside = await mkdtemp(join(tmpdir(), 'pi-logo-restore-outside-'));
      const victim = join(outside, 'victim.png');
      await writeFile(victim, 'outside-must-stay');
      await mkdir(join(outputRoot, 'audit-logo'), { recursive: true });
      const assetPath = join(outputRoot, 'audit-logo', 'openzeppelin.png');
      await writeFile(assetPath, 'old-logo');
      const mutations = [{ relPath: 'audit-logo/openzeppelin.png', restoreBase64: Buffer.from('old-logo').toString('base64') }];
      await unlink(assetPath);
      await symlink(victim, assetPath);

      await assert.rejects(
        () => cleanupCreatedLogoAssets(outputRoot, mutations),
        /unsafe logo asset restore target/,
      );
      assert.equal(await readFile(victim, 'utf8'), 'outside-must-stay');
    },
  },
];
