// Spawns `claude -p` with schema-forced output. Handles at most one retry on
// transient failures, parses the envelope, returns it. Higher-level extraction
// of structured_output happens in subtask-runner.

import { spawn } from 'node:child_process';

const TRANSIENT_PATTERNS = [
  /529/i,
  /overloaded/i,
  /timeout/i,
  /ECONNRESET/i,
  /503/i,
  /502/i,
];

export async function runClaude({
  claudeBin = 'claude',
  systemPrompt = '',
  userPrompt,
  schemaJson,
  maxTurns,
  maxBudgetUsd,
  permissionMode = 'bypassPermissions',
  allowedTools = 'WebFetch,WebSearch',
  resumeSession = null,
  model = null,
  retryOnTransient = true,
  retryDelayMs = 2000,
  budgetLedger = null,
}) {
  if (!userPrompt) throw new Error('runClaude: userPrompt is required');
  if (!schemaJson) throw new Error('runClaude: schemaJson is required');

  const attempt = async () => {
    const attemptBudget = budgetLedger ? Math.min(maxBudgetUsd, budgetLedger.remaining()) : maxBudgetUsd;
    if (!(attemptBudget > 0)) throw new Error('max-budget exhausted before claude attempt');
    const env = await spawnAndCollect({
      claudeBin, systemPrompt, userPrompt, schemaJson,
      maxTurns, maxBudgetUsd: attemptBudget, permissionMode, allowedTools, resumeSession, model,
    });
    if (budgetLedger && Number.isFinite(env.total_cost_usd)) budgetLedger.record(env.total_cost_usd);
    return env;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!retryOnTransient || !isTransient(err)) throw err;
    await sleep(retryDelayMs);
    return await attempt();
  }
}

function isTransient(err) {
  const msg = (err && err.message) || '';
  const stderr = (err && err.stderr) || '';
  return TRANSIENT_PATTERNS.some(p => p.test(msg) || p.test(stderr));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnAndCollect({
  claudeBin, systemPrompt, userPrompt, schemaJson,
  maxTurns, maxBudgetUsd, permissionMode, allowedTools, resumeSession, model,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '-',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schemaJson),
      '--max-turns', String(maxTurns),
      '--max-budget-usd', String(maxBudgetUsd),
      '--permission-mode', permissionMode,
      '--allowed-tools', allowedTools,
    ];
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    if (resumeSession) args.push('--resume', resumeSession);
    if (model) args.push('--model', model);

    const proc = spawn(claudeBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', err => reject(Object.assign(err, { stderr })));
    proc.on('close', code => {
      if (code !== 0) {
        return reject(Object.assign(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`), { code, stderr, stdout }));
      }
      let env;
      try { env = JSON.parse(stdout); }
      catch (e) { return reject(Object.assign(new Error(`claude stdout not JSON: ${e.message}`), { stdout, stderr })); }
      resolve(env);
    });
    proc.stdin.end(userPrompt);
  });
}
