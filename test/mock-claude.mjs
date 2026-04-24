#!/usr/bin/env node
// Minimal mock of `claude -p` for testing translate.mjs.
// Reads stdin (the user prompt), outputs a canned response envelope.
//
// Env vars:
//   MOCK_RESPONSE  — JSON string to return as .result (default: echo back input)
//   MOCK_EXIT_CODE — process exit code (default: 0)

import { readFileSync } from 'node:fs';

const stdin = readFileSync(0, 'utf8');
const exitCode = parseInt(process.env.MOCK_EXIT_CODE || '0', 10);

if (exitCode !== 0) {
  process.stderr.write(`mock-claude: simulated failure (exit ${exitCode})\n`);
  process.exit(exitCode);
}

let response;
if (process.env.MOCK_RESPONSE) {
  response = process.env.MOCK_RESPONSE;
} else {
  // Default: parse input JSON and return it unchanged (echo-back mode)
  response = stdin;
}

const envelope = {
  type: 'result',
  result: response,
  session_id: 'mock-session-001',
  total_cost_usd: 0.001,
  num_turns: 1,
};

process.stdout.write(JSON.stringify(envelope));
process.exit(0);
