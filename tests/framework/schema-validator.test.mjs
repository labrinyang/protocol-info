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
