#!/usr/bin/env node
// Extract the first balanced JSON object from stdin.
// Handles: leading prose, trailing prose, ```json fences, embedded strings with braces.
// Exits 0 + writes JSON to stdout on success; non-zero on failure.

import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');

// Strip code fences if any
let s = input.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '');

const start = s.indexOf('{');
if (start < 0) {
  process.stderr.write('extract-json: no "{" found in input\n');
  process.exit(2);
}

let depth = 0;
let inStr = false;
let esc = false;
for (let i = start; i < s.length; i++) {
  const c = s[i];
  if (esc) { esc = false; continue; }
  if (inStr) {
    if (c === '\\') esc = true;
    else if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') inStr = true;
  else if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth === 0) {
      const obj = s.slice(start, i + 1);
      // Validate by parsing
      try {
        JSON.parse(obj);
      } catch (e) {
        process.stderr.write(`extract-json: candidate not valid JSON: ${e.message}\n`);
        process.exit(3);
      }
      process.stdout.write(obj);
      process.exit(0);
    }
  }
}

process.stderr.write('extract-json: unbalanced braces (EOF before closing "}")\n');
process.exit(4);
