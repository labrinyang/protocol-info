import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function seedRecord() {
  const out = await mkdtemp(join(tmpdir(), 'pi-get-'));
  await mkdir(join(out, 'pendle'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
    name: 'Pendle',
    members: [{ oneLiner: 'core contributor' }],
  }));
  return out;
}

export const tests = [
  {
    name: 'get prints a JSONPath value',
    fn: async () => {
      const out = await seedRecord();
      let stdout = '';
      const cmd = (await import('../../../framework/commands/get.mjs')).default;
      const code = await cmd(['pendle', 'members[0].oneLiner'], {
        outputRoot: out,
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout), 'core contributor');
    },
  },
  {
    name: 'get exits 1 when path is missing',
    fn: async () => {
      const out = await seedRecord();
      let stderr = '';
      const cmd = (await import('../../../framework/commands/get.mjs')).default;
      const code = await cmd(['pendle', 'members[1].oneLiner'], {
        outputRoot: out,
        stdout: { write: () => {} },
        stderr: { write: (s) => { stderr += s; } },
      });
      assert.equal(code, 1);
      assert.match(stderr, /not found/);
    },
  },
];
