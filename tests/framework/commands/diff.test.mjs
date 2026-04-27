import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepo, commit } from '../../../framework/version-store.mjs';

export const tests = [
  {
    name: 'diff prints HEAD~1..HEAD by default',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-diff-'));
      await ensureRepo(out);
      await mkdir(join(out, 'pendle'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":1}\n');
      await commit(out, { paths: ['pendle/'], message: 'a', runId: 'A' });
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      await commit(out, { paths: ['pendle/'], message: 'b', runId: 'B' });

      let stdout = '';
      const cmd = (await import('../../../framework/commands/diff.mjs')).default;
      const code = await cmd(['pendle'], {
        outputRoot: out,
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.match(stdout, /-{"v":1}/);
      assert.match(stdout, /\+{"v":2}/);
    },
  },
];
