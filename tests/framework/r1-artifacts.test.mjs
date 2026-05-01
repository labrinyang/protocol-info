import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStaleR1Envelopes, r1EnvelopePath } from '../../framework/r1-artifacts.mjs';

export const tests = [
  {
    name: 'clearStaleR1Envelopes removes only current manifest subtask envelopes',
    fn: async () => {
      const debugDir = await mkdtemp(join(tmpdir(), 'pi-r1-artifacts-'));
      await mkdir(debugDir, { recursive: true });
      await writeFile(r1EnvelopePath(debugDir, 'metadata'), '{"stale":true}');
      await writeFile(r1EnvelopePath(debugDir, 'audits'), '{"stale":true}');
      await writeFile(r1EnvelopePath(debugDir, 'legacy'), '{"keep":true}');
      await writeFile(join(debugDir, 'r1-status.json'), '{"state":"old"}');
      await writeFile(join(debugDir, 'metadata.stderr.log'), 'keep');

      await clearStaleR1Envelopes(debugDir, [
        { name: 'metadata' },
        { name: 'audits' },
        { name: 'metadata' },
        { name: '' },
      ]);

      assert.equal(existsSync(r1EnvelopePath(debugDir, 'metadata')), false);
      assert.equal(existsSync(r1EnvelopePath(debugDir, 'audits')), false);
      assert.equal(existsSync(r1EnvelopePath(debugDir, 'legacy')), true);
      assert.equal(existsSync(join(debugDir, 'r1-status.json')), true);
      assert.equal(existsSync(join(debugDir, 'metadata.stderr.log')), true);
    },
  },
];
