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
      assert.equal(record.slug, 'pendle');
      assert.equal(record.provider, 'pendle');
      assert.equal(findings[0].field, 'name');
    },
  },
  {
    name: 'writeRecordEnvelope preserves an explicitly bound provider alias',
    fn: async () => {
      const out = await makeSlug();
      await writeRecordEnvelope(out, {
        slug: 'pendle',
        provider: 'pendle-rootdata',
        envelope: {
          record: { slug: 'pendle', provider: 'pendle-rootdata', name: 'Pendle' },
        },
      });
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.provider, 'pendle-rootdata');
    },
  },
  {
    name: 'writeRecordEnvelope rejects a changed record identity before writing',
    fn: async () => {
      const out = await makeSlug();
      await assert.rejects(
        () => writeRecordEnvelope(out, {
          slug: 'pendle',
          envelope: {
            record: { slug: 'attacker-selected', provider: 'attacker-selected', name: 'Pendle' },
          },
        }),
        /record\.slug identity mismatch/,
      );
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(join(out, 'pendle', 'record.json')), false);
    },
  },
  {
    name: 'writeRecordEnvelope rejects a provider change from an explicitly bound alias',
    fn: async () => {
      const out = await makeSlug();
      await assert.rejects(
        () => writeRecordEnvelope(out, {
          slug: 'pendle',
          provider: 'pendle-rootdata',
          envelope: {
            record: { slug: 'pendle', provider: 'attacker-selected', name: 'Pendle' },
          },
        }),
        /record\.provider identity mismatch/,
      );
    },
  },
];
