import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepo, commit } from '../../../framework/version-store.mjs';

export const tests = [
  {
    name: 'diff defaults to the latest two commits for the selected slug',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-diff-'));
      await ensureRepo(out);
      await mkdir(join(out, 'pendle'), { recursive: true });
      await mkdir(join(out, 'morpho'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":1}\n');
      await commit(out, { paths: ['pendle/'], message: 'a', runId: 'A' });
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      await commit(out, { paths: ['pendle/'], message: 'b', runId: 'B' });
      await writeFile(join(out, 'morpho', 'record.json'), '{"v":1}\n');
      await commit(out, { paths: ['morpho/'], message: 'morpho', runId: 'M' });

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
      assert.doesNotMatch(stdout, /morpho/);
    },
  },
  {
    name: 'diff returns a clear error when the slug has fewer than two commits',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-diff-'));
      await ensureRepo(out);
      await mkdir(join(out, 'pendle'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":1}\n');
      await commit(out, { paths: ['pendle/'], message: 'a', runId: 'A' });

      let stderr = '';
      const cmd = (await import('../../../framework/commands/diff.mjs')).default;
      const code = await cmd(['pendle'], {
        outputRoot: out,
        stdout: { write: () => {} },
        stderr: { write: (s) => { stderr += s; } },
      });
      assert.equal(code, 1);
      assert.match(stderr, /needs at least two commits/);
    },
  },
];
