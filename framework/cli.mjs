#!/usr/bin/env node
// framework/cli.mjs — Node-side CLI entry. Mirrors run.sh's argv contract,
// loads .env (if not already loaded by run.sh), assembles providers, and
// delegates to framework/orchestrator.mjs:run(). Phase 9.2 will collapse
// run.sh to delegate to this file.
//
// Argv contract (matches run.sh):
//   --display-name <name>     (per-provider; required at least once)
//   --type <type>             (per-provider; OPTIONAL — model-inferred if absent)
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
//   --dry-run                 list providers + bail
//   --force-overwrite         overwrite an out/<slug>/ that has uncommitted changes
//   -h, --help                print help
//
// .env autoload order (only if ROOTDATA_API_KEY not already set):
//   1. <SCRIPT_DIR>/.env
//   2. $HOME/.config/protocol-info/.env

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { run, slugify } from './orchestrator.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(FRAMEWORK_DIR);
const DEFAULT_MANIFEST = join(SCRIPT_DIR, 'consumers', 'protocol-info', 'manifest.json');

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
      setKeys.push(key);
    }
  }
  return { found: true, setKeys };
}

// Lookup order for ROOTDATA_API_KEY (highest priority first):
//   1. --rootdata-key CLI flag (handled in argv loop below)
//   2. existing process.env.ROOTDATA_API_KEY
//   3. ~/.config/protocol-info/.env  ← user-writable, survives plugin updates
//   4. <SCRIPT_DIR>/.env             ← standalone repo only (read-only when
//                                       installed as a Claude Code plugin)
const ROOTDATA_ENV_CANDIDATES = [
  join(homedir(), '.config', 'protocol-info', '.env'),
  join(SCRIPT_DIR, '.env'),
];
let rootdataKeyOrigin = process.env.ROOTDATA_API_KEY ? 'shell-env' : null;
if (!process.env.ROOTDATA_API_KEY) {
  for (const candidate of ROOTDATA_ENV_CANDIDATES) {
    const r = loadEnvFile(candidate);
    if (r.found && r.setKeys.includes('ROOTDATA_API_KEY')) {
      rootdataKeyOrigin = candidate;
      break;
    }
  }
}

// ── argv parsing ────────────────────────────────────────────────────────────

const HELP = `通过 framework/cli.mjs 批量抓取协议信息记录。

用法：
  node framework/cli.mjs --display-name "Pendle" --type fixed_rate
  node framework/cli.mjs --batch --display-name "A" --type t1 --batch --display-name "B" --type t2
  node framework/cli.mjs --i18n all --display-name "Pendle" --type fixed_rate

Per-provider flags (use --batch to separate multiple providers):
  --display-name <name>   required
  --type <type>           OPTIONAL (model-inferred if absent)
  --slug <slug>           OPTIONAL (slugified from display-name if absent)
  --hints <text>          OPTIONAL
  --rootdata-id <int>     OPTIONAL
  --batch                 flush accumulated provider; start a new one

Run-wide flags:
  --model <name>          override Claude model for R1+R2 (manifest default: claude-sonnet-4-6)
  --rootdata-key <key>    ROOTDATA_API_KEY for this run; overrides env + .env files
  --max-turns <n>         per-Claude-call turn cap (clamps manifest default)
  --max-budget <usd>      single-provider total LLM cap
  --parallel <n>          default 1; dry-run forces 1
  --i18n <flag>           "none" | "all" | "zh_CN,ja_JP,..." | "" (silent skip)
  --i18n-parallel <n>     default 8
  --i18n-model <name>     override i18n model (default haiku)
  --dry-run               list providers and bail
  --force-overwrite       overwrite an out/<slug>/ that has uncommitted changes
  -h, --help              this help

Outputs:
  out/<slug>/record.json
  out/<slug>/record.full.json   (only when --i18n produced translations)
  out/<slug>/meta.json
  out/<slug>/_debug/             audit / debug artefacts
  out/<slug>/summary.tsv         per-protocol run summary
  out/.runs/<run-id>/summary.tsv batch summary
`;

// Pure argv parser. Does NOT exit the process or print to stdout/stderr —
// throws on validation errors. Side effect: a `--rootdata-key VALUE` flag
// updates process.env.ROOTDATA_API_KEY (preserves prior behavior so the
// fetcher dispatcher picks the key up).
export function parseArgv(argv) {
  const providers = [];
  let cur = { dn: '', type: '', slug: '', hints: '', rid: '' };
  let manifestPath = DEFAULT_MANIFEST;
  let model = '';
  let parallel = 1;
  let i18nArg = '';
  let i18nParallel = 8;
  let i18nModel = '';
  let dryRun = false;
  let maxTurnsCap = '';
  let maxBudgetCap = '';
  let forceOverwrite = false;
  let helpRequested = false;
  let localRootdataKeyOrigin = rootdataKeyOrigin;

  function flush() {
    if (!cur.dn && !cur.type) return;
    if (!cur.dn) {
      throw new Error('--display-name 为必填参数');
    }
    const slug = cur.slug || slugify(cur.dn);
    const provider = {
      slug,
      provider: slug,
      displayName: cur.dn,
      type: cur.type || '',
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
    cur = { dn: '', type: '', slug: '', hints: '', rid: '' };
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
        const key = nextArg().trim();
        if (key) {
          process.env.ROOTDATA_API_KEY = key;
          localRootdataKeyOrigin = '--rootdata-key';
        }
        break;
      }
      case '--max-turns':      maxTurnsCap = nextArg(); break;
      case '--max-budget':     maxBudgetCap = nextArg(); break;
      case '--parallel':       parallel = parseInt(nextArg(), 10); break;
      case '--i18n':           i18nArg = nextArg(); break;
      case '--i18n-parallel':  i18nParallel = parseInt(nextArg(), 10); break;
      case '--i18n-model':     i18nModel = nextArg(); break;
      case '--dry-run':        dryRun = true; break;
      case '--force-overwrite': forceOverwrite = true; break;
      case '--display-name':   cur.dn = nextArg(); break;
      case '--type':           cur.type = nextArg(); break;
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
      model,
      dryRun,
      rootdataKeyOrigin: localRootdataKeyOrigin,
      maxTurnsCap,
      maxBudgetCap,
      forceOverwrite,
    },
  };
}

// ── Main entry (only when run as a script) ──────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
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
    model,
    dryRun,
    rootdataKeyOrigin: parsedRootdataKeyOrigin,
    maxTurnsCap,
    maxBudgetCap,
    forceOverwrite,
  } = options;
  let parallel = parsedParallel;
  rootdataKeyOrigin = parsedRootdataKeyOrigin;

  if (providers.length === 0) {
    process.stderr.write('错误: 至少需要提供一个 provider（--display-name + --type）\n');
    process.stderr.write('用法: node framework/cli.mjs --display-name "Protocol Name" --type simple_earn\n');
    process.stderr.write('批量: node framework/cli.mjs --batch --display-name "A" --type t1 --batch --display-name "B" --type t2\n');
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

  const ROOTDATA_ENABLED = !!process.env.ROOTDATA_API_KEY;
  const RUN_TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const outputRoot = join(SCRIPT_DIR, 'out');
  const runSummaryDir = join(outputRoot, '.runs', RUN_TS);

  const rootdataLabel = ROOTDATA_ENABLED
    ? `enabled (Round 2) [key from ${rootdataKeyOrigin || 'shell-env'}]`
    : 'disabled (single-round; no ROOTDATA_API_KEY found — pass --rootdata-key, export the env var, or write ~/.config/protocol-info/.env)';

  console.log('=== Protocol-info crawl ===');
  console.log(`Providers:   ${providers.length}`);
  console.log(`Model:       ${model || 'default'}`);
  console.log(`Parallel:    ${parallel}`);
  console.log(`RootData:    ${rootdataLabel}`);
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
