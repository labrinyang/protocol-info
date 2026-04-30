#!/usr/bin/env node
// framework/cli.mjs — Node-side CLI entry. Mirrors run.sh's argv contract,
// loads .env (if not already loaded by run.sh), assembles providers, and
// delegates to framework/orchestrator.mjs:run(). Phase 9.2 will collapse
// run.sh to delegate to this file.
//
// Argv contract (matches run.sh):
//   --display-name <name>     (per-provider; required at least once)
//   --slug <slug>             (per-provider; OPTIONAL — slugified from display)
//   --hints <text>            (per-provider; OPTIONAL)
//   --rootdata-id <int>       (per-provider; OPTIONAL)
//   --batch                   flush accumulated provider info; allows multiple
//   --model <name>            applies to every provider's R1 and R2
//   --max-turns <n>           per-Claude-call cap (clamps manifest default down)
//   --max-budget <usd>        single-provider total LLM cap
//   --parallel <n>            default 1; dry-run forces 1
//   --i18n <flag>             "none" | "all" | "zh_CN,ja_JP,..." | empty
//   --i18n-parallel <n>       default 8
//   --i18n-model <name>       default Haiku (manifest default)
//   --r2-routing <mode>       single_provider | external_first | external_first_with_claude_fallback
//   --dry-run                 list providers + bail
//   --force-overwrite         overwrite an out/<slug>/ that has uncommitted changes
//   -h, --help                print help
//
// Default output root is the caller's current working directory:
//   <cwd>/out
//
// .env autoload order (only fills variables not already set):
//   1. $HOME/.config/protocol-info/.env
//   2. <SCRIPT_DIR>/.env

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { run, slugify } from './orchestrator.mjs';
import { rootDataApiKeysFromEnv, hasRootDataApiKeys } from '../consumers/protocol-info/fetchers/rootdata.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(FRAMEWORK_DIR);
const DEFAULT_MANIFEST = join(SCRIPT_DIR, 'consumers', 'protocol-info', 'manifest.json');
export const WORKFLOW_COMMANDS = {
  get: () => import('./commands/get.mjs'),
  set: () => import('./commands/set.mjs'),
  analyze: () => import('./commands/analyze.mjs'),
  i18n: () => import('./commands/i18n.mjs'),
  refresh: () => import('./commands/refresh.mjs'),
  history: () => import('./commands/history.mjs'),
  diff: () => import('./commands/diff.mjs'),
  restore: () => import('./commands/restore.mjs'),
};

// ── .env autoload (tolerant: skip if run.sh already loaded vars) ────────────

function loadEnvFile(path) {
  if (!existsSync(path)) return { found: false, setKeys: [] };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { found: true, setKeys: [], error: 'unreadable' };
  }
  const setKeys = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Treat blank values as missing — avoids shadowing a real key set in a
    // later .env or stomping the existing process env with empty string.
    if (val === '') continue;
    // Already-set env wins (matches bash `set -a` + `source` semantics where
    // an exported var in the calling shell would take precedence).
    if (process.env[key] === undefined) {
      process.env[key] = val;
      process.env[`PROTOCOL_INFO_ENV_ORIGIN_${key}`] ??= path;
      setKeys.push(key);
    }
  }
  return { found: true, setKeys };
}

function envOrigin(key) {
  if (!process.env[key]) return null;
  return process.env[`PROTOCOL_INFO_ENV_ORIGIN_${key}`] || 'shell-env';
}

function rootDataOrigin() {
  return envOrigin('ROOTDATA_API_KEYS')
    || envOrigin('ROOTDATA_API_KEY')
    || Object.keys(process.env)
      .filter((key) => /^ROOTDATA_API_KEY_\d+$/i.test(key))
      .sort()
      .map((key) => envOrigin(key))
      .find(Boolean)
    || null;
}

function setEnvFromFlag(key, value, origin) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  process.env[key] = trimmed;
  process.env[`PROTOCOL_INFO_ENV_ORIGIN_${key}`] = origin;
  return true;
}

// Lookup order for ROOTDATA_API_KEY (highest priority first):
//   1. --rootdata-key CLI flag (handled in argv loop below; may contain a list)
//   2. existing process.env.ROOTDATA_API_KEYS / ROOTDATA_API_KEY
//   3. ~/.config/protocol-info/.env  ← user-writable, survives plugin updates
//   4. <SCRIPT_DIR>/.env             ← standalone repo only (read-only when
//                                       installed as a Claude Code plugin)
const ROOTDATA_ENV_CANDIDATES = [
  join(homedir(), '.config', 'protocol-info', '.env'),
  join(SCRIPT_DIR, '.env'),
];
let rootdataKeyOrigin = rootDataOrigin();
let openAIOrigins = {
  apiKey: envOrigin('OPENAI_API_KEY'),
  baseUrl: envOrigin('OPENAI_BASE_URL'),
  model: envOrigin('OPENAI_MODEL'),
  inputCost: envOrigin('OPENAI_INPUT_COST_PER_1M') || envOrigin('OPENAI_INPUT_COST_PER_1K'),
  outputCost: envOrigin('OPENAI_OUTPUT_COST_PER_1M') || envOrigin('OPENAI_OUTPUT_COST_PER_1K'),
};
let unavatarKeyOrigin = envOrigin('UNAVATAR_API_KEY');
let runtimeEnvLoaded = false;

export function defaultOutputRoot(cwd = process.cwd()) {
  return join(cwd, 'out');
}

export function loadRuntimeEnv(candidates = ROOTDATA_ENV_CANDIDATES) {
  if (runtimeEnvLoaded) return { rootdataKeyOrigin, openAIOrigins, unavatarKeyOrigin };
  runtimeEnvLoaded = true;
  for (const candidate of candidates) {
    const r = loadEnvFile(candidate);
    if (!rootdataKeyOrigin && r.found && r.setKeys.some((key) => /^ROOTDATA_API_KEY(?:S|_\d+)?$/i.test(key))) {
      rootdataKeyOrigin = candidate;
    }
    if (!unavatarKeyOrigin && r.found && r.setKeys.includes('UNAVATAR_API_KEY')) {
      unavatarKeyOrigin = candidate;
    }
  }
  // Backward compatibility for older fetcher dispatch env gates. The RootData
  // fetcher itself reads the whole key pool from ROOTDATA_API_KEYS,
  // ROOTDATA_API_KEY, and numbered ROOTDATA_API_KEY_N variables.
  const rootKeys = rootDataApiKeysFromEnv(process.env);
  if (!process.env.ROOTDATA_API_KEY && rootKeys.length > 0) {
    process.env.ROOTDATA_API_KEY = rootKeys[0];
    process.env.PROTOCOL_INFO_ENV_ORIGIN_ROOTDATA_API_KEY ??= rootdataKeyOrigin || 'shell-env';
  }
  rootdataKeyOrigin = rootDataOrigin();
  openAIOrigins = {
    apiKey: envOrigin('OPENAI_API_KEY'),
    baseUrl: envOrigin('OPENAI_BASE_URL'),
    model: envOrigin('OPENAI_MODEL'),
    inputCost: envOrigin('OPENAI_INPUT_COST_PER_1M') || envOrigin('OPENAI_INPUT_COST_PER_1K'),
    outputCost: envOrigin('OPENAI_OUTPUT_COST_PER_1M') || envOrigin('OPENAI_OUTPUT_COST_PER_1K'),
  };
  unavatarKeyOrigin = envOrigin('UNAVATAR_API_KEY');
  return { rootdataKeyOrigin, openAIOrigins, unavatarKeyOrigin };
}

// ── argv parsing ────────────────────────────────────────────────────────────

const HELP = `通过 framework/cli.mjs 批量抓取协议信息记录。

用法：
  node framework/cli.mjs --display-name "Pendle"
  node framework/cli.mjs --batch --display-name "A" --batch --display-name "B"
  node framework/cli.mjs --i18n all --display-name "Pendle"

Per-provider flags (use --batch to separate multiple providers):
  --display-name <name>   required
  --slug <slug>           OPTIONAL (slugified from display-name if absent)
  --hints <text>          OPTIONAL
  --rootdata-id <int>     OPTIONAL
  --batch                 flush accumulated provider; start a new one
  record.type is inferred from evidence; it is not a CLI input.

Run-wide flags:
  --model <name>          override Claude model for R1+R2 (manifest default: claude-sonnet-4-6)
  --rootdata-key <key>    ROOTDATA_API_KEY(S) for this run; comma/newline lists are allowed
  --unavatar-key <key>    UNAVATAR_API_KEY for paid Unavatar avatar/logo rehosting
  --openai-api-key <key>  OPENAI_API_KEY for this run; overrides env + .env files
  --openai-base-url <url> OPENAI_BASE_URL for this run
  --openai-model <name>   OPENAI_MODEL for OpenAI-compatible routes
  --openai-input-cost-per-1m <usd>   external input-token price, per 1M tokens
  --openai-output-cost-per-1m <usd>  external output-token price, per 1M tokens
  --max-turns <n>         per-Claude-call turn cap (clamps manifest default)
  --max-budget <usd>      single-provider total LLM cap
  --parallel <n>          default 1; dry-run forces 1
  --i18n <flag>           "none" | "all" | "zh_CN,ja_JP,..." | "" (silent skip)
  --i18n-parallel <n>     default 8
  --i18n-model <name>     override i18n model (default haiku; OpenAI uses OPENAI_MODEL)
  --r2-routing <mode>     single_provider (default), external_first, or external_first_with_claude_fallback
                          Optional env: I18N_PROVIDER=openai, R2_LLM_PROVIDER=openai,
                          R2_ROUTING=external_first|external_first_with_claude_fallback,
                          R2_ASSIST_PROVIDER=openai, R2_FALLBACK_PROVIDER=claude,
                          ANALYZE_LLM_PROVIDER=openai, AUDIT_REPORTS_LLM_PROVIDER=openai,
                          REFRESH_AUDITS_LLM_PROVIDER=openai
                          Optional pricing: OPENAI_INPUT_COST_PER_1M, OPENAI_OUTPUT_COST_PER_1M
  --dry-run               list providers and bail
  --force-overwrite       overwrite an out/<slug>/ that has uncommitted changes
  -h, --help              this help

Outputs:
  <current-directory>/out/<slug>/record.json
  <current-directory>/out/<slug>/record.full.json   (only when --i18n produced translations)
  <current-directory>/out/<slug>/meta.json
  <current-directory>/out/<slug>/_debug/             audit / debug artefacts (gitignored)
  <current-directory>/out/.runs/<run-id>/summary.tsv batch summary (gitignored)
  <current-directory>/out/.runs.log                  append-only TSV of every batch run (gitignored)

Workflow commands (v2.1):
  get <slug> <jsonpath>          print one value from out/<slug>/record.json
  set <slug> <jsonpath> <json>   edit one value with validation + commit
  analyze <slug> <jsonpath> --query <text> [--apply]
                              research one value; apply validates + commits
  i18n <slug> [--locales LIST]   translate current record, post-process, commit
  refresh <slug> <subtask>       rerun metadata/team/funding/audits and merge
  history <slug> [--limit N]     show git history for one protocol
  diff <slug> [from] [to]        show git diff for one protocol (default: latest two slug commits)
  restore <slug> <sha>           restore a previous commit, validate, commit
`;

export async function dispatchWorkflowCommand(argv, {
  commandMap = WORKFLOW_COMMANDS,
  context = {},
} = {}) {
  const parsed = parseWorkflowArgv(argv, commandMap);
  if (!parsed) return null;
  const mod = await commandMap[parsed.name]();
  const fn = mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`workflow command ${parsed.name} has no default export`);
  }
  return await fn(parsed.args, {
    outputRoot: defaultOutputRoot(),
    manifestPath: DEFAULT_MANIFEST,
    ...parsed.context,
    ...context,
  });
}

export function parseWorkflowArgv(argv, commandMap = WORKFLOW_COMMANDS) {
  let name = null;
  const args = [];
  const context = {};

  const nextArg = (i, flag) => {
    if (i + 1 >= argv.length) {
      throw new Error(`${flag} 缺少参数`);
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force-overwrite') {
      context.forceOverwrite = true;
      continue;
    }
    if (a === '--manifest') {
      context.manifestPath = nextArg(i, a);
      i += 1;
      continue;
    }
    if (a === '--model') {
      context.model = nextArg(i, a);
      i += 1;
      continue;
    }
    if (a === '--i18n-model') {
      context.i18nModel = nextArg(i, a);
      i += 1;
      continue;
    }
    if (a === '--rootdata-key') {
      setEnvFromFlag('ROOTDATA_API_KEY', nextArg(i, a), '--rootdata-key');
      i += 1;
      continue;
    }
    if (a === '--unavatar-key') {
      setEnvFromFlag('UNAVATAR_API_KEY', nextArg(i, a), '--unavatar-key');
      i += 1;
      continue;
    }
    if (a === '--openai-api-key') {
      setEnvFromFlag('OPENAI_API_KEY', nextArg(i, a), '--openai-api-key');
      i += 1;
      continue;
    }
    if (a === '--openai-base-url') {
      setEnvFromFlag('OPENAI_BASE_URL', nextArg(i, a), '--openai-base-url');
      i += 1;
      continue;
    }
    if (a === '--openai-model') {
      setEnvFromFlag('OPENAI_MODEL', nextArg(i, a), '--openai-model');
      i += 1;
      continue;
    }
    if (a === '--openai-input-cost-per-1m') {
      setEnvFromFlag('OPENAI_INPUT_COST_PER_1M', nextArg(i, a), '--openai-input-cost-per-1m');
      i += 1;
      continue;
    }
    if (a === '--openai-output-cost-per-1m') {
      setEnvFromFlag('OPENAI_OUTPUT_COST_PER_1M', nextArg(i, a), '--openai-output-cost-per-1m');
      i += 1;
      continue;
    }

    if (!name) {
      if (a in commandMap) {
        name = a;
        continue;
      }
      return null;
    }
    args.push(a);
  }

  return name ? { name, args, context } : null;
}

// Pure argv parser. Does NOT exit the process or print to stdout/stderr —
// throws on validation errors. Side effect: a `--rootdata-key VALUE` flag
// updates process.env.ROOTDATA_API_KEY (preserves prior behavior so the
// fetcher dispatcher picks the key up).
export function parseArgv(argv) {
  const providers = [];
  let cur = { dn: '', slug: '', hints: '', rid: '' };
  let manifestPath = DEFAULT_MANIFEST;
  let model = '';
  let parallel = 1;
  let i18nArg = '';
  let i18nParallel = 8;
  let i18nModel = '';
  let r2Routing = '';
  let dryRun = false;
  let maxTurnsCap = '';
  let maxBudgetCap = '';
  let forceOverwrite = false;
  let helpRequested = false;
  let localRootdataKeyOrigin = rootdataKeyOrigin;
  let localUnavatarKeyOrigin = unavatarKeyOrigin;
  let localOpenAIOrigins = { ...openAIOrigins };

  function flush() {
    if (!cur.dn) return;
    const slug = cur.slug || slugify(cur.dn);
    const provider = {
      slug,
      provider: slug,
      displayName: cur.dn,
      hints: cur.hints || '',
    };
    if (cur.rid) {
      const n = Number(cur.rid);
      if (!Number.isFinite(n)) {
        throw new Error(`--rootdata-id 必须是整数 (got ${cur.rid})`);
      }
      provider.rootdataId = n;
    }
    providers.push(provider);
    cur = { dn: '', slug: '', hints: '', rid: '' };
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nextArg = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`${a} 缺少参数`);
      }
      return argv[++i];
    };
    switch (a) {
      case '--manifest':       manifestPath = nextArg(); break;
      case '--model':          model = nextArg(); break;
      case '--rootdata-key': {
        if (setEnvFromFlag('ROOTDATA_API_KEY', nextArg(), '--rootdata-key')) {
          localRootdataKeyOrigin = '--rootdata-key';
        }
        break;
      }
      case '--unavatar-key': {
        if (setEnvFromFlag('UNAVATAR_API_KEY', nextArg(), '--unavatar-key')) {
          localUnavatarKeyOrigin = '--unavatar-key';
        }
        break;
      }
      case '--openai-api-key': {
        if (setEnvFromFlag('OPENAI_API_KEY', nextArg(), '--openai-api-key')) {
          localOpenAIOrigins = { ...localOpenAIOrigins, apiKey: '--openai-api-key' };
        }
        break;
      }
      case '--openai-base-url': {
        if (setEnvFromFlag('OPENAI_BASE_URL', nextArg(), '--openai-base-url')) {
          localOpenAIOrigins = { ...localOpenAIOrigins, baseUrl: '--openai-base-url' };
        }
        break;
      }
      case '--openai-model': {
        if (setEnvFromFlag('OPENAI_MODEL', nextArg(), '--openai-model')) {
          localOpenAIOrigins = { ...localOpenAIOrigins, model: '--openai-model' };
        }
        break;
      }
      case '--openai-input-cost-per-1m': {
        if (setEnvFromFlag('OPENAI_INPUT_COST_PER_1M', nextArg(), '--openai-input-cost-per-1m')) {
          localOpenAIOrigins = { ...localOpenAIOrigins, inputCost: '--openai-input-cost-per-1m' };
        }
        break;
      }
      case '--openai-output-cost-per-1m': {
        if (setEnvFromFlag('OPENAI_OUTPUT_COST_PER_1M', nextArg(), '--openai-output-cost-per-1m')) {
          localOpenAIOrigins = { ...localOpenAIOrigins, outputCost: '--openai-output-cost-per-1m' };
        }
        break;
      }
      case '--max-turns':      maxTurnsCap = nextArg(); break;
      case '--max-budget':     maxBudgetCap = nextArg(); break;
      case '--parallel':       parallel = parseInt(nextArg(), 10); break;
      case '--i18n':           i18nArg = nextArg(); break;
      case '--i18n-parallel':  i18nParallel = parseInt(nextArg(), 10); break;
      case '--i18n-model':     i18nModel = nextArg(); break;
      case '--r2-routing':     r2Routing = nextArg(); break;
      case '--dry-run':        dryRun = true; break;
      case '--force-overwrite': forceOverwrite = true; break;
      case '--display-name':   cur.dn = nextArg(); break;
      case '--type':
        throw new Error('--type 不再是 CLI 输入字段；record.type 由 metadata 阶段根据证据推断');
      case '--slug':           cur.slug = nextArg(); break;
      case '--hints':          cur.hints = nextArg(); break;
      case '--rootdata-id':    cur.rid = nextArg(); break;
      case '--batch':          flush(); break;
      case '-h':
      case '--help':
        helpRequested = true;
        break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  flush();

  return {
    manifestPath,
    providers,
    helpRequested,
    options: {
      parallel,
      i18nArg,
      i18nParallel,
      i18nModel,
      r2Routing,
      model,
      dryRun,
      rootdataKeyOrigin: localRootdataKeyOrigin,
      unavatarKeyOrigin: localUnavatarKeyOrigin,
      openAIOrigins: localOpenAIOrigins,
      maxTurnsCap,
      maxBudgetCap,
      forceOverwrite,
    },
  };
}

// ── Main entry (only when run as a script) ──────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const rawArgv = process.argv.slice(2);
  loadRuntimeEnv();
  try {
    const workflowCode = await dispatchWorkflowCommand(rawArgv);
    if (workflowCode != null) {
      process.exit(workflowCode);
    }
  } catch (err) {
    process.stderr.write(`workflow command failed: ${err.stack || err.message}\n`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseArgv(rawArgv);
  } catch (err) {
    process.stderr.write(`错误: ${err.message}\n`);
    process.exit(1);
  }

  if (parsed.helpRequested) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const { manifestPath, providers, options } = parsed;
  const {
    parallel: parsedParallel,
    i18nArg,
    i18nParallel,
    i18nModel,
    r2Routing,
    model,
    dryRun,
    rootdataKeyOrigin: parsedRootdataKeyOrigin,
    unavatarKeyOrigin: parsedUnavatarKeyOrigin,
    openAIOrigins: parsedOpenAIOrigins,
    maxTurnsCap,
    maxBudgetCap,
    forceOverwrite,
  } = options;
  let parallel = parsedParallel;
  rootdataKeyOrigin = parsedRootdataKeyOrigin;
  unavatarKeyOrigin = parsedUnavatarKeyOrigin;
  openAIOrigins = parsedOpenAIOrigins;

  if (providers.length === 0) {
    process.stderr.write('错误: 至少需要提供一个 provider（--display-name）\n');
    process.stderr.write('用法: node framework/cli.mjs --display-name "Protocol Name"\n');
    process.stderr.write('批量: node framework/cli.mjs --batch --display-name "A" --batch --display-name "B"\n');
    process.exit(1);
  }

  if (!Number.isInteger(parallel) || parallel < 1) {
    process.stderr.write(`错误: --parallel 必须是正整数（当前: ${parallel}）\n`);
    process.exit(1);
  }
  if (!Number.isInteger(i18nParallel) || i18nParallel < 1) {
    process.stderr.write(`错误: --i18n-parallel 必须是正整数（当前: ${i18nParallel}）\n`);
    process.exit(1);
  }

  let maxTurns = null;
  if (maxTurnsCap !== '') {
    const n = parseInt(maxTurnsCap, 10);
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write(`错误: --max-turns 必须是正整数（当前: ${maxTurnsCap}）\n`);
      process.exit(1);
    }
    maxTurns = n;
  }

  let maxBudget = null;
  if (maxBudgetCap !== '') {
    const n = Number(maxBudgetCap);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`错误: --max-budget 必须是正数（当前: ${maxBudgetCap}）\n`);
      process.exit(1);
    }
    maxBudget = n;
  }

  for (const key of [
    'OPENAI_INPUT_COST_PER_1M',
    'OPENAI_OUTPUT_COST_PER_1M',
    'OPENAI_INPUT_COST_PER_1K',
    'OPENAI_OUTPUT_COST_PER_1K',
  ]) {
    if (process.env[key] !== undefined) {
      const n = Number(process.env[key]);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`错误: ${key} 必须是非负数（当前: ${process.env[key]}）\n`);
        process.exit(1);
      }
    }
  }

  // dry-run forces parallel=1
  if (dryRun) parallel = 1;

  // ── i18n label for header line ───────────────────────────────────────────
  let i18nLabel;
  switch (i18nArg) {
    case '':     i18nLabel = 'skip (no --i18n flag — silent skip)'; break;
    case 'none': i18nLabel = 'skip'; break;
    case 'all':  i18nLabel = 'all languages (from manifest catalog)'; break;
    default:     i18nLabel = i18nArg;
  }

  const ROOTDATA_ENABLED = hasRootDataApiKeys(process.env);
  const RUN_TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const outputRoot = defaultOutputRoot();
  const runSummaryDir = join(outputRoot, '.runs', RUN_TS);

  const rootdataKeyCount = rootDataApiKeysFromEnv(process.env).length;
  const rootdataLabel = ROOTDATA_ENABLED
    ? `enabled (Round 2) [${rootdataKeyCount} key${rootdataKeyCount === 1 ? '' : 's'} from ${rootdataKeyOrigin || 'shell-env'}]`
    : 'disabled (single-round; no ROOTDATA_API_KEY(S) found — pass --rootdata-key, export ROOTDATA_API_KEY(S), or write ~/.config/protocol-info/.env)';
  const unavatarLabel = process.env.UNAVATAR_API_KEY
    ? `configured [key from ${unavatarKeyOrigin || 'shell-env'}]`
    : 'not configured (avatar rehosting can still try anonymous Unavatar but may be rate-limited)';
  const openAIRouteRequested = [
    'I18N_PROVIDER',
    'R1_LLM_PROVIDER',
    'R2_LLM_PROVIDER',
    'ANALYZE_LLM_PROVIDER',
    'AUDIT_REPORTS_LLM_PROVIDER',
    'AUDIT_REPORT_LLM_PROVIDER',
    'REFRESH_LLM_PROVIDER',
    'REFRESH_AUDITS_LLM_PROVIDER',
  ].some((key) => String(process.env[key] || '').toLowerCase() === 'openai');
  const openAIPricingReady = !!(
    (process.env.OPENAI_INPUT_COST_PER_1M || process.env.OPENAI_INPUT_COST_PER_1K)
    && (process.env.OPENAI_OUTPUT_COST_PER_1M || process.env.OPENAI_OUTPUT_COST_PER_1K)
  );
  const openAILabel = process.env.OPENAI_API_KEY
    ? `configured [key from ${openAIOrigins.apiKey || 'shell-env'}, base=${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'} (${openAIOrigins.baseUrl || 'default'}), model=${process.env.OPENAI_MODEL || 'unset'} (${openAIOrigins.model || 'unset'}), pricing=${openAIPricingReady ? 'configured' : 'unknown'}]`
    : openAIRouteRequested
      ? 'requested but missing OPENAI_API_KEY — pass --openai-api-key, export env, or write ~/.config/protocol-info/.env'
      : 'not configured';

  console.log('=== Protocol-info crawl ===');
  console.log(`Providers:   ${providers.length}`);
  console.log(`Model:       ${model || 'default'}`);
  console.log(`Parallel:    ${parallel}`);
  console.log(`RootData:    ${rootdataLabel}`);
  console.log(`Unavatar:    ${unavatarLabel}`);
  console.log(`External LLM: ${openAILabel}`);
  console.log(`i18n:        ${i18nLabel} [model=${i18nModel || 'default'}, parallel=${i18nParallel}]`);
  console.log(`Run id:      ${RUN_TS}`);
  console.log(`Out root:    ${outputRoot}`);
  console.log(`Summary:     ${join(runSummaryDir, 'summary.tsv')}`);
  console.log('');

  // Bail early if claude / node not available?  framework/cli/r1.mjs handles
  // claude-bin discovery itself; we just trust the path.

  try {
    await run({
      manifestPath,
      providers,
      outputRoot,
      runId: RUN_TS,
      parallelism: parallel,
      dryRun,
      options: {
        model,
        i18nArg,
        i18nParallel,
        i18nModel,
        r2Routing,
        maxTurns,
        maxBudget,
        forceOverwrite,
      },
    });
  } catch (err) {
    process.stderr.write(`orchestrator failed: ${err.stack || err.message}\n`);
    process.exit(1);
  }
}
