#!/usr/bin/env node
import { runPool } from '../translate.mjs';

let _pass = 0, _fail = 0;
function assert(condition, msg) {
  if (condition) _pass++;
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b),
    `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
process.on('exit', () => {
  console.log(`  ${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exitCode = 1;
});

// ── Test 1: Basic execution, order preserved ──
{
  const tasks = [1, 2, 3].map(n => () => Promise.resolve(n * 10));
  const results = await runPool(tasks, 2);
  assertEq(results.length, 3, 'result count');
  assertEq(results[0], { ok: true, value: 10 }, 'result[0]');
  assertEq(results[1], { ok: true, value: 20 }, 'result[1]');
  assertEq(results[2], { ok: true, value: 30 }, 'result[2]');
}

// ── Test 2: Failure isolation ──
{
  const tasks = [
    () => Promise.resolve('ok'),
    () => Promise.reject(new Error('boom')),
    () => Promise.resolve('also ok'),
  ];
  const results = await runPool(tasks, 3);
  assert(results[0].ok === true, 'first task ok');
  assert(results[1].ok === false, 'second task failed');
  assert(results[1].error.message === 'boom', 'error message preserved');
  assert(results[2].ok === true, 'third task ok despite second failing');
}

// ── Test 3: Concurrency limit ──
{
  let running = 0;
  let maxRunning = 0;

  const tasks = Array.from({ length: 6 }, (_, i) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, 20));
    running--;
    return i;
  });

  await runPool(tasks, 2);
  assert(maxRunning <= 2, `concurrency respected: maxRunning=${maxRunning} <= 2`);
  assert(maxRunning >= 1, `at least 1 ran concurrently: maxRunning=${maxRunning}`);
}

// ── Test 4: Empty tasks ──
{
  const results = await runPool([], 5);
  assertEq(results.length, 0, 'empty tasks returns empty results');
}
