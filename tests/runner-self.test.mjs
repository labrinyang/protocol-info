import { strict as assert } from 'node:assert';
export const tests = [
  { name: 'runner can execute a passing test', fn: async () => { assert.equal(1 + 1, 2); } },
];
