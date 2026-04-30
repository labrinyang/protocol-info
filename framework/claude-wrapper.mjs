// Spawns `claude -p` with schema-forced output. Handles at most one retry on
// transient failures, parses the envelope, returns it. Higher-level extraction
// of structured_output happens in subtask-runner.

import { spawn } from 'node:child_process';

const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5 * 1000;

const TRANSIENT_PATTERNS = [
  /\b529\b/,
  /\boverloaded\b/i,
  /\btimeout\b/i,
  /\bECONNRESET\b/,
  /\b503\b/,
  /\b502\b/,
];

function parseTimeoutMs(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export function resolveClaudeTimeoutMs({ timeoutMs, env = process.env, defaultMs = DEFAULT_CLAUDE_TIMEOUT_MS } = {}) {
  const explicit = parseTimeoutMs(timeoutMs);
  if (explicit !== undefined) return explicit === 0 ? null : explicit;
  const envValue = parseTimeoutMs(env?.CLAUDE_WATCHDOG_TIMEOUT_MS ?? env?.CLAUDE_TIMEOUT_MS);
  if (envValue !== undefined) return envValue === 0 ? null : envValue;
  return defaultMs;
}

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
  timeoutMs = undefined,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  env = process.env,
  onSpawn = null,
}) {
  if (!userPrompt) throw Object.assign(new Error('runClaude: userPrompt is required'), { kind: 'arg_invalid' });
  if (!schemaJson) throw Object.assign(new Error('runClaude: schemaJson is required'), { kind: 'arg_invalid' });

  const attempt = async () => {
    const attemptBudget = budgetLedger ? Math.min(maxBudgetUsd, budgetLedger.remaining()) : maxBudgetUsd;
    if (!(attemptBudget > 0)) throw Object.assign(new Error('max-budget exhausted before claude attempt'), { kind: 'budget_exhausted' });
    const invocationTimeoutMs = resolveClaudeTimeoutMs({ timeoutMs, env });
    const envResult = await spawnAndCollect({
      claudeBin, systemPrompt, userPrompt, schemaJson,
      maxTurns, maxBudgetUsd: attemptBudget, permissionMode, allowedTools, resumeSession, model,
      timeoutMs: invocationTimeoutMs, killGraceMs, onSpawn,
    });
    if (budgetLedger && Number.isFinite(envResult.total_cost_usd)) budgetLedger.record(envResult.total_cost_usd);
    return envResult;
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
  if (err?.kind === 'timeout') return false;
  const msg = (err && err.message) || '';
  const stderr = (err && err.stderr) || '';
  return TRANSIENT_PATTERNS.some(p => p.test(msg) || p.test(stderr));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnAndCollect({
  claudeBin, systemPrompt, userPrompt, schemaJson,
  maxTurns, maxBudgetUsd, permissionMode, allowedTools, resumeSession, model,
  timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS, onSpawn = null,
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

    const useProcessGroup = process.platform !== 'win32';
    const proc = spawn(claudeBin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: useProcessGroup });
    let stdout = '', stderr = '';
    let settled = false;
    let closed = false;
    const startedAt = Date.now();
    let timeoutTimer = null;
    let killTimer = null;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      fn(value);
    }

    function killInvocation(signal) {
      if (!proc.pid) return;
      if (useProcessGroup) {
        try {
          process.kill(-proc.pid, signal);
          return;
        } catch { /* fall back to killing only the direct child */ }
      }
      try { proc.kill(signal); } catch { /* best effort */ }
    }

    if (typeof onSpawn === 'function') {
      try {
        onSpawn({ pid: proc.pid, started_at: new Date(startedAt).toISOString(), timeout_ms: timeoutMs ?? null });
      } catch { /* telemetry hook must not affect the invocation */ }
    }

    if (timeoutMs != null && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const elapsedMs = Date.now() - startedAt;
        const err = Object.assign(
          new Error(`claude invocation timed out after ${elapsedMs}ms (pid=${proc.pid ?? 'unknown'})`),
          {
            kind: 'timeout',
            pid: proc.pid ?? null,
            elapsed_ms: elapsedMs,
            timeout_ms: timeoutMs,
            stderr,
            stdout,
          }
        );
        killInvocation('SIGTERM');
        killTimer = setTimeout(() => {
          if (!closed) {
            killInvocation('SIGKILL');
          }
        }, killGraceMs);
        if (typeof killTimer.unref === 'function') killTimer.unref();
        settle(reject, err);
      }, timeoutMs);
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    }

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', err => settle(reject, Object.assign(err, { stderr, kind: 'spawn_error' })));
    proc.on('close', code => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      let env = null;
      let parseErr = null;
      try { env = JSON.parse(stdout); }
      catch (e) { parseErr = e; }

      if (env !== null) {
        // Most envelopes resolve here (including `is_error: true` for permanent errors
        // like schema mismatches or budget exhaustion — those should NOT retry).
        // Exception: when `is_error: true` AND the message looks transient (529/503/
        // overload/timeout), throw so the outer retry path engages — same policy as
        // a thrown spawn error.
        if (env.is_error === true) {
          const txt = typeof env.result === 'string' ? env.result : '';
          if (TRANSIENT_PATTERNS.some(p => p.test(txt))) {
            return settle(reject, Object.assign(
              new Error(`claude transient envelope error: ${txt.slice(0, 300)}`),
              { code, stderr, stdout, kind: 'transient_envelope', envelope: env }
            ));
          }
        }
        return settle(resolve, env);
      }

      // No parseable envelope. Decide error kind by exit code.
      if (code !== 0) {
        return settle(reject, Object.assign(
          new Error(`claude exit ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`),
          { code, stderr, stdout, kind: 'exit_nonzero' }
        ));
      }
      return settle(reject, Object.assign(
        new Error(`claude stdout not JSON: ${parseErr?.message || 'unknown'}`),
        { stdout, stderr, kind: 'stdout_not_json' }
      ));
    });
    proc.stdin.end(userPrompt);
  });
}
