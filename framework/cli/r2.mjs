#!/usr/bin/env node
// CLI wrapper for framework/r2-runner.mjs.

import { runR2Reconcile } from '../r2-runner.mjs';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const params = {
  manifestPath: arg('manifest'),
  recordIn: arg('record-in'),
  findingsIn: arg('findings-in'),
  gapsIn: arg('gaps-in'),
  handoffIn: arg('handoff-in'),
  evidencePath: arg('evidence'),
  recordOut: arg('record-out'),
  findingsOut: arg('findings-out'),
  changesOut: arg('changes-out'),
  gapsOut: arg('gaps-out'),
  debugDir: arg('debug-dir'),
  model: arg('model'),
  llmProvider: arg('llm-provider'),
  routing: arg('routing'),
  maxTurnsCap: arg('max-turns'),
  maxBudgetCap: arg('max-budget'),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  env: process.env,
  logger: console,
};

if (!params.manifestPath || !params.recordIn || !params.findingsIn || !params.gapsIn || !params.recordOut || !params.debugDir) {
  console.error('usage: r2.mjs --manifest M --record-in R --findings-in F --gaps-in G [--handoff-in H] [--evidence E] --record-out R2 [--findings-out F2] [--changes-out C2] [--gaps-out G2] --debug-dir D');
  process.exit(2);
}

try {
  const result = await runR2Reconcile(params);
  if (!result.ok) {
    console.error(`[r2] failed before any acceptable synthesis: ${result.firstFailure || 'unknown'}`);
    process.exit(1);
  }
  console.error(`[r2] done — synthesis complete (${result.selected || 'unknown'})`);
  process.exit(0);
} catch (err) {
  console.error(`[r2] fatal: ${err.stack || err.message}`);
  process.exit(err.kind === 'arg_invalid' ? 2 : 1);
}
