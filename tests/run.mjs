#!/usr/bin/env node
// Zero-dep test runner. Discovers tests/**/*.test.mjs, runs each, reports pass/fail.
// Each test file exports `tests` = [{name, fn}]. fn may be async; throws/rejects = fail.
//
// Usage:
//   node tests/run.mjs                         # run all
//   node tests/run.mjs framework/merger        # filter by substring of file path

import { readdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const filter = process.argv[2] || '';

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && ent.name.endsWith('.test.mjs')) yield p;
  }
}

const RED = '\x1b[31m', GREEN = '\x1b[32m', GREY = '\x1b[90m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
const failures = [];

for await (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (filter && !rel.includes(filter)) continue;
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    console.error(`${RED}LOAD FAIL${RESET} ${rel}: ${err.message}`);
    failed++;
    failures.push({ file: rel, name: '(load)', err });
    continue;
  }
  if (!Array.isArray(mod.tests)) {
    console.error(`${RED}NO TESTS${RESET} ${rel} (missing exported \`tests\`)`);
    failed++;
    continue;
  }
  for (const t of mod.tests) {
    process.stdout.write(`${GREY}${rel}${RESET} :: ${t.name} ... `);
    try {
      await t.fn();
      console.log(`${GREEN}ok${RESET}`);
      passed++;
    } catch (err) {
      console.log(`${RED}FAIL${RESET}`);
      console.log(`  ${err.stack || err.message}`);
      failed++;
      failures.push({ file: rel, name: t.name, err });
    }
  }
}

console.log(`\n${passed + failed} tests · ${GREEN}${passed} passed${RESET} · ${failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed'}`);
process.exit(failed > 0 ? 1 : 0);
