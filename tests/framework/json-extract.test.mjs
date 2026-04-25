import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

function extract(input) {
  const r = spawnSync('node', ['framework/json-extract.mjs'], { input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const tests = [
  {
    name: 'extracts plain JSON object',
    fn: async () => {
      const r = extract('{"a":1}');
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), { a: 1 });
    },
  },
  {
    name: 'extracts JSON from markdown fence',
    fn: async () => {
      const r = extract('Here:\n```json\n{"a":1}\n```\nbye');
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), { a: 1 });
    },
  },
  {
    name: 'extracts first balanced object from prose',
    fn: async () => {
      const r = extract('text {"x":2,"nested":{"y":3}} more text');
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), { x: 2, nested: { y: 3 } });
    },
  },
  {
    name: 'fails on no JSON',
    fn: async () => {
      const r = extract('only prose, no braces');
      assert.notEqual(r.code, 0);
    },
  },
];
