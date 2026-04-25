import { strict as assert } from 'node:assert';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchFetchers } from '../../framework/fetcher-dispatcher.mjs';

async function withFakeFetcher(body, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'));
  const path = join(dir, 'fake.mjs');
  await writeFile(path, body);
  try { return await fn(path); }
  finally { await rm(dir, { recursive: true }); }
}

export const tests = [
  {
    name: 'dispatches multiple fetchers in parallel and merges by name',
    fn: async () => {
      await withFakeFetcher(
        `export default async () => ({ name: 'a', ok: true, data: {x: 1}, cost_usd: 0, fetched_at: 'now' });`,
        async (aPath) => {
          await withFakeFetcher(
            `export default async () => ({ name: 'b', ok: true, data: {y: 2}, cost_usd: 0, fetched_at: 'now' });`,
            async (bPath) => {
              const packet = await dispatchFetchers({
                fetchers: [
                  { name: 'a', module_abs: aPath, optional: true, required_env: [] },
                  { name: 'b', module_abs: bPath, optional: true, required_env: [] },
                ],
                ctx: { slug: 's', displayName: 'S', hints: '', env: {}, logger: { info: () => {}, warn: () => {} } },
              });
              assert.deepEqual(packet.fetchers_run, ['a', 'b']);
              assert.deepEqual(packet.a, { x: 1 });
              assert.deepEqual(packet.b, { y: 2 });
              assert.equal(packet.fetcher_status.a, 'ok');
              assert.equal(packet.fetcher_status.b, 'ok');
            },
          );
        },
      );
    },
  },
  {
    name: 'keyless fetcher runs even when sibling needs missing env',
    fn: async () => {
      await withFakeFetcher(
        `export default async () => ({ name: 'rootdata', ok: true, data: {anchors: 1}, cost_usd: 0, fetched_at: 'now' });`,
        async (rdPath) => {
          await withFakeFetcher(
            `export default async () => ({ name: 'defillama', ok: true, data: {category: 'dex'}, cost_usd: 0, fetched_at: 'now' });`,
            async (dlPath) => {
              const packet = await dispatchFetchers({
                fetchers: [
                  { name: 'rootdata', module_abs: rdPath, optional: true, required_env: ['ROOTDATA_API_KEY'] },
                  { name: 'defillama', module_abs: dlPath, optional: true, required_env: [] },
                ],
                ctx: { slug: 's', displayName: 'S', hints: '', env: {}, logger: { info: () => {}, warn: () => {} } },
              });
              assert.match(packet.fetcher_status.rootdata, /^skipped:/);
              assert.equal(packet.fetcher_status.defillama, 'ok');
              assert.deepEqual(packet.defillama, { category: 'dex' });
            },
          );
        },
      );
    },
  },
  {
    name: 'continues when an optional fetcher fails',
    fn: async () => {
      await withFakeFetcher(
        `export default async () => ({ name: 'a', ok: false, data: null, error: 'boom', cost_usd: 0, fetched_at: 'now' });`,
        async (aPath) => {
          await withFakeFetcher(
            `export default async () => ({ name: 'b', ok: true, data: {y: 2}, cost_usd: 0, fetched_at: 'now' });`,
            async (bPath) => {
              const packet = await dispatchFetchers({
                fetchers: [
                  { name: 'a', module_abs: aPath, optional: true, required_env: [] },
                  { name: 'b', module_abs: bPath, optional: true, required_env: [] },
                ],
                ctx: { slug: 's', displayName: 'S', hints: '', env: {}, logger: { info: () => {}, warn: () => {} } },
              });
              assert.equal(packet.fetcher_status.a, 'failed: boom');
              assert.equal(packet.fetcher_status.b, 'ok');
              assert.deepEqual(packet.b, { y: 2 });
              assert.equal('a' in packet, false);
            },
          );
        },
      );
    },
  },
];
