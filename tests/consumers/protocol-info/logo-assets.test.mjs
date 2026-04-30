import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import normalize from '../../../consumers/protocol-info/normalizers/logo-assets.mjs';
import { LOGO_CDN_BASE } from '../../../framework/logo-assets.mjs';

async function tempOut() {
  return mkdtemp(join(tmpdir(), 'pi-logo-assets-'));
}

function fakeImageFetch({ contentType = 'image/png', bytes = 'image' } = {}) {
  const calls = [];
  const fetchImage = async (url, options = undefined) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
      arrayBuffer: async () => Buffer.from(bytes),
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
      assert.deepEqual(createdLogoAssetPaths, ['protocol-logo/pendle.png']);
      assert.deepEqual(Object.keys(first.record).slice(0, 3), ['slug', 'provider', 'providerLogoUrl']);

      const second = await normalize({ record: first.record, evidence, outputRoot, fetchImage });
      assert.equal(second.record.providerLogoUrl, first.record.providerLogoUrl);
      assert.equal(calls.length, 1);
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
          arrayBuffer: async () => Buffer.from('unavatar-image'),
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
      assert.equal(await readFile(join(outputRoot, 'protocol-member-logo', 'pendle-tn-lee.png'), 'utf8'), 'unavatar-image');
      assert.match(out.changes[0].reason, /member_logo_rehosted_via_unavatar_fallback/);
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
      assert.equal(await readFile(join(outputRoot, 'protocol-member-logo', 'pendle-alice-liu.jpg'), 'utf8'), 'image');
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
      assert.equal(await readFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'utf8'), 'manual-fix');
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
      assert.equal(await readFile(join(outputRoot, 'audit-logo', 'openzeppelin.png'), 'utf8'), 'image');
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
];
