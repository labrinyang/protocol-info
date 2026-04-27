import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecordEnvelope, writeRecordEnvelope } from '../../framework/record-state.mjs';

async function makeSlug() {
  const out = await mkdtemp(join(tmpdir(), 'pi-state-'));
  await mkdir(join(out, 'pendle'), { recursive: true });
  return out;
}

export const tests = [
  {
    name: 'loadRecordEnvelope loads record and defaults missing sidecars to arrays',
    fn: async () => {
      const out = await makeSlug();
      await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({ name: 'Pendle' }));
      const env = await loadRecordEnvelope(out, { slug: 'pendle' });
      assert.deepEqual(env, { record: { name: 'Pendle' }, findings: [], changes: [], gaps: [] });
    },
  },
  {
    name: 'loadRecordEnvelope loads existing sidecars',
    fn: async () => {
      const out = await makeSlug();
      await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({ name: 'Pendle' }));
      await writeFile(join(out, 'pendle', 'findings.json'), JSON.stringify([{ field: 'name' }]));
      await writeFile(join(out, 'pendle', 'changes.json'), JSON.stringify([{ field: 'name' }]));
      await writeFile(join(out, 'pendle', 'gaps.json'), JSON.stringify([{ field: 'x' }]));
      const env = await loadRecordEnvelope(out, { slug: 'pendle' });
      assert.equal(env.findings[0].field, 'name');
      assert.equal(env.changes[0].field, 'name');
      assert.equal(env.gaps[0].field, 'x');
    },
  },
  {
    name: 'writeRecordEnvelope writes record and sidecars',
    fn: async () => {
      const out = await makeSlug();
      await writeRecordEnvelope(out, {
        slug: 'pendle',
        envelope: {
          record: { name: 'Pendle' },
          findings: [{ field: 'name' }],
          changes: [{ field: 'name' }],
          gaps: [],
        },
      });
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      const findings = JSON.parse(await readFile(join(out, 'pendle', 'findings.json'), 'utf8'));
      assert.equal(record.name, 'Pendle');
      assert.equal(findings[0].field, 'name');
    },
  },
];
