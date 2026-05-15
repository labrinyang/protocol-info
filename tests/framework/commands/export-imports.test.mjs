import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tests = [
  {
    name: 'export-imports copies valid imports and writes combined report',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-export-imports-'));
      await mkdir(join(out, 'pendle'), { recursive: true });
      await mkdir(join(out, 'missing'), { recursive: true });
      await mkdir(join(out, 'bad'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.import.json'), JSON.stringify({
        version: '1.0',
        exportedAt: '2026-05-15T00:00:00.000Z',
        data: [{ slug: 'pendle', locale: 'en' }],
      }) + '\n');
      await writeFile(join(out, 'bad', 'record.import.json'), '{"version":"1.0"}\n');

      const cmd = (await import('../../../framework/commands/export-imports.mjs')).default;
      const code = await cmd(['--out', 'Aimports', '--combined'], {
        outputRoot: out,
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      const copied = JSON.parse(await readFile(join(out, 'Aimports', 'pendle.json'), 'utf8'));
      assert.equal(copied.data[0].slug, 'pendle');
      const combined = JSON.parse(await readFile(join(out, 'Aimports', 'combined.import.json'), 'utf8'));
      assert.deepEqual(combined.data, [{ slug: 'pendle', locale: 'en' }]);
      const report = JSON.parse(await readFile(join(out, 'Aimports', 'export-report.json'), 'utf8'));
      assert.deepEqual(report.copied.map((entry) => entry.slug), ['pendle']);
      assert.deepEqual(report.missing.map((entry) => entry.slug), ['missing']);
      assert.deepEqual(report.invalid.map((entry) => entry.slug), ['bad']);
    },
  },
];
