import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepo, commit } from '../../../framework/version-store.mjs';

export const tests = [
  {
    name: 'history prints commits for one slug',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-history-'));
      await ensureRepo(out);
      await mkdir(join(out, 'pendle'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":1}\n');
      await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): ok', runId: 'R1' });
      await writeFile(join(out, 'pendle', 'record.json'), '{"v":2}\n');
      await commit(out, { paths: ['pendle/'], message: 'set(pendle) v', runId: 'R2' });

      let stdout = '';
      const cmd = (await import('../../../framework/commands/history.mjs')).default;
      const code = await cmd(['pendle', '--limit', '1'], {
        outputRoot: out,
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      const lines = stdout.trim().split('\n');
      assert.equal(lines.length, 1);
      assert.match(lines[0], /set\(pendle\) v/);
      assert.match(lines[0], /R2$/);
    },
  },
];
