import { strict as assert } from 'node:assert';
import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, selectEvidence } from '../../framework/manifest-loader.mjs';

async function withManifest(json, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mf-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(json));
  try { return await fn(join(dir, 'manifest.json'), dir); }
  finally { await rm(dir, { recursive: true }); }
}

export const tests = [
  {
    name: 'loads minimal valid manifest',
    fn: async () => {
      await withManifest({ name: 'x', version: '0.1.0' }, async (path) => {
        const m = await loadManifest(path);
        assert.equal(m.name, 'x');
      });
    },
  },
  {
    name: 'rejects manifest with bad name',
    fn: async () => {
      await withManifest({ name: 'BAD NAME', version: '0.1.0' }, async (path) => {
        await assert.rejects(() => loadManifest(path), /manifest schema validation failed/);
      });
    },
  },
  {
    name: 'resolves all module/prompt/schema paths to absolute',
    fn: async () => {
      await withManifest({
        name: 'x', version: '0.1.0',
        fetchers: [{ name: 'a', module: './a.mjs' }],
        system_prompt: './p/sys.md',
        subtasks: [{ name: 's', prompt: './p/s.md', schema_slice: './sch/s.json' }],
      }, async (path, dir) => {
        await writeFile(join(dir, 'a.mjs'), 'export default async () => ({ ok: true })');
        await mkdir(join(dir, 'p'), { recursive: true });
        await mkdir(join(dir, 'sch'), { recursive: true });
        await writeFile(join(dir, 'p/sys.md'), 'system');
        await writeFile(join(dir, 'p/s.md'), 'prompt');
        await writeFile(join(dir, 'sch/s.json'), '{"type":"object"}');
        const m = await loadManifest(path);
        assert.equal(m._abs.fetchers[0].module_abs, join(dir, 'a.mjs'));
        assert.equal(m._abs.system_prompt, join(dir, 'p/sys.md'));
        assert.equal(m._abs.subtasks[0].prompt_abs, join(dir, 'p/s.md'));
        assert.equal(m._abs.subtasks[0].schema_slice_abs, join(dir, 'sch/s.json'));
      });
    },
  },
  {
    name: 'rejects missing referenced files',
    fn: async () => {
      await withManifest({
        name: 'x', version: '0.1.0',
        system_prompt: './missing/system.md',
      }, async (path) => {
        await assert.rejects(() => loadManifest(path), /missing referenced file/);
      });
    },
  },
  {
    name: 'selectEvidence picks subtree by dot-path',
    fn: async () => {
      const packet = { rootdata: { anchors: { x: 1 }, members: [] }, defillama: { tvl: 100 } };
      const out = selectEvidence(packet, ['rootdata.anchors', 'defillama.tvl']);
      assert.deepEqual(out, { rootdata: { anchors: { x: 1 } }, defillama: { tvl: 100 } });
    },
  },
  {
    name: 'selectEvidence skips missing paths silently',
    fn: async () => {
      const out = selectEvidence({ a: 1 }, ['x.y.z']);
      assert.deepEqual(out, {});
    },
  },
];
