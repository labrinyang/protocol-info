import { strict as assert } from 'node:assert';
import { runWithLimit } from '../../framework/parallel-runner.mjs';

export const tests = [
  {
    name: 'runs all tasks and preserves order in returned results',
    fn: async () => {
      const results = await runWithLimit(2, [
        () => Promise.resolve(1),
        () => Promise.resolve(2),
        () => Promise.resolve(3),
        () => Promise.resolve(4),
      ]);
      assert.deepEqual(results, [1, 2, 3, 4]);
    },
  },
  {
    name: 'respects concurrency limit',
    fn: async () => {
      let active = 0;
      let peak = 0;
      const tasks = Array.from({ length: 8 }, () => async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 20));
        active--;
        return 'ok';
      });
      await runWithLimit(3, tasks);
      assert.ok(peak <= 3, `peak ${peak} exceeded limit 3`);
      assert.ok(peak >= 2, `peak ${peak} suspiciously low — concurrency may be 1`);
    },
  },
  {
    name: 'collects failures alongside successes when collectErrors=true',
    fn: async () => {
      const results = await runWithLimit(2, [
        () => Promise.resolve('a'),
        () => Promise.reject(new Error('boom')),
        () => Promise.resolve('c'),
      ], { collectErrors: true });
      assert.equal(results[0].ok, true);
      assert.equal(results[0].value, 'a');
      assert.equal(results[1].ok, false);
      assert.match(results[1].error.message, /boom/);
      assert.equal(results[2].ok, true);
      assert.equal(results[2].value, 'c');
    },
  },
];
