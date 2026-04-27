import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runValidator(schema, instance) {
  const tmp = await mkdtemp(join(tmpdir(), 'sv-'));
  const schemaPath = join(tmp, 'schema.json');
  const instancePath = join(tmp, 'instance.json');
  await writeFile(schemaPath, JSON.stringify(schema));
  await writeFile(instancePath, JSON.stringify(instance));
  const res = spawnSync('node', ['framework/schema-validator.mjs', instancePath, '--schema', schemaPath], { encoding: 'utf8' });
  await rm(tmp, { recursive: true });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

export const tests = [
  {
    name: 'module import exposes reusable validator helpers without running CLI',
    fn: async () => {
      const mod = await import('../../framework/schema-validator.mjs');
      assert.equal(typeof mod.validate, 'function');
      assert.equal(typeof mod.validateFile, 'function');
      assert.equal(typeof mod.validateRecord, 'function');
      assert.equal(typeof mod.main, 'function');
    },
  },
  {
    name: 'validateRecord returns ok/errors for in-memory records',
    fn: async () => {
      const { validateRecord } = await import('../../framework/schema-validator.mjs');
      const schema = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };
      assert.deepEqual(await validateRecord({ x: 1 }, schema), { ok: true, errors: [] });
      const bad = await validateRecord({ x: 'nope' }, schema);
      assert.equal(bad.ok, false);
      assert.match(bad.errors[0], /\$\.x: expected number, got string/);
    },
  },
  {
    name: 'validateFile validates against a supplied schema object',
    fn: async () => {
      const { validateFile } = await import('../../framework/schema-validator.mjs');
      const tmp = await mkdtemp(join(tmpdir(), 'sv-file-'));
      const instancePath = join(tmp, 'instance.json');
      await writeFile(instancePath, JSON.stringify({ x: 'bad' }));
      const errors = await validateFile(instancePath, {
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'number' } },
      });
      await rm(tmp, { recursive: true });
      assert.equal(errors.length, 1);
      assert.match(errors[0], /\$\.x: expected number/);
    },
  },
  {
    name: 'validates a passing instance',
    fn: async () => {
      const r = await runValidator(
        { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
        { x: 1 }
      );
      assert.equal(r.code, 0);
    },
  },
  {
    name: 'rejects a failing instance',
    fn: async () => {
      const r = await runValidator(
        { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
        { x: 'not a number' }
      );
      assert.notEqual(r.code, 0);
    },
  },
];
