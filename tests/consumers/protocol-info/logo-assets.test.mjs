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
  const fetchImage = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
      arrayBuffer: async () => Buffer.from(bytes),
    };
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
