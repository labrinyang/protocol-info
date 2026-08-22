import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCanonicalPostProcessing } from '../../framework/canonical-post.mjs';

const manifest = { output: { import_filename: 'record.import.json' } };

async function tempSlugDir() {
  return mkdtemp(join(tmpdir(), 'pi-canonical-post-'));
}

export const tests = [
  {
    name: 'canonical post validation removes stale output before a zero-exit post run',
    fn: async () => {
      const slugDir = await tempSlugDir();
      const importPath = join(slugDir, 'record.import.json');
      await writeFile(importPath, JSON.stringify({ data: [{ slug: 'pendle', provider: 'pendle' }] }));
      const result = await runCanonicalPostProcessing({
        runPostProcessing: async () => 0,
        slugDir,
        manifest,
        slug: 'pendle',
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /canonical import was not written/);
      await assert.rejects(() => readFile(importPath), /ENOENT/);
    },
  },
  {
    name: 'canonical post validation accepts a non-empty identity-bound envelope',
    fn: async () => {
      const slugDir = await tempSlugDir();
      const result = await runCanonicalPostProcessing({
        runPostProcessing: async () => {
          await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({
            data: [{ slug: 'pendle', provider: 'pendle' }],
          }));
          return 0;
        },
        slugDir,
        manifest,
        slug: 'pendle',
      });
      assert.equal(result.ok, true);
      assert.equal(result.envelope.data.length, 1);
    },
  },
  {
    name: 'canonical post validation rejects output whose requested identity changes',
    fn: async () => {
      const slugDir = await tempSlugDir();
      const result = await runCanonicalPostProcessing({
        runPostProcessing: async () => {
          await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({
            data: [{ slug: 'pendle', provider: 'attacker-selected' }],
          }));
          return 0;
        },
        slugDir,
        manifest,
        slug: 'pendle',
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /provider identity mismatch/);
    },
  },
];
