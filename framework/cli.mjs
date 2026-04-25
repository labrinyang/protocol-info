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
//   --model <name>            applies to every provider's R1, R2, and i18n
//   --max-turns <n>           per-Claude-call cap (clamps manifest default down)
//   --max-budget <usd>        per-Claude-call USD cap (clamps manifest default down)
//   --parallel <n>            default 1; dry-run forces 1
//   --i18n <flag>             "none" | "all" | "zh_CN,ja_JP,..." | empty
//   --i18n-parallel <n>       default 8
//   --i18n-model <name>       default Haiku (manifest default)
//   --dry-run                 list providers + bail (r1.mjs has no --dry-run)
//   -h, --help                print help
//
// .env autoload order (only if ROOTDATA_API_KEY not already set):
//   1. <SCRIPT_DIR>/.env
//   2. $HOME/.config/protocol-info/.env

import { mkdir } from 'node:fs/promises';
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
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Already-set env wins (matches bash `set -a` + `source` semantics where
      // an exported var in the calling shell would take precedence)
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return true;
  } catch {
    return false;
  }
}

// Skip .env autoload if ROOTDATA_API_KEY already set (e.g. exported by user
// or sourced by run.sh). Match bash precedence.
if (process.env.ROOTDATA_API_KEY === undefined) {
  for (const candidate of [
    join(SCRIPT_DIR, '.env'),
    join(homedir(), '.config', 'protocol-info', '.env'),
  ]) {
    if (loadEnvFile(candidate)) break;
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
  --model <name>          override Claude model (R1+R2+i18n)
  --max-turns <n>         per-Claude-call turn cap (clamps manifest default)
  --max-budget <usd>      per-Claude-call USD cap (clamps manifest default)
  --parallel <n>          default 1; dry-run forces 1
  --i18n <flag>           "none" | "all" | "zh_CN,ja_JP,..." | "" (silent skip)
  --i18n-parallel <n>     default 8
  --i18n-model <name>     default haiku
  --dry-run               list providers and bail
  -h, --help              this help

Outputs:
  out/<ts>/summary.tsv
  out/<ts>/<slug>/record.json
  out/<ts>/<slug>/record.full.json   (only when --i18n produced translations)
  out/<ts>/<slug>/meta.json
  out/<ts>/<slug>/_debug/             audit / debug artefacts
`;

const argv = process.argv.slice(2);

const providers = [];
let cur = { dn: '', type: '', slug: '', hints: '', rid: '' };
let model = '';
let parallel = 1;
let i18nArg = '';
let i18nParallel = 8;
let i18nModel = '';
let dryRun = false;
let manifestPath = DEFAULT_MANIFEST;
let maxTurnsCap = '';
let maxBudgetCap = '';

function flush() {
  if (!cur.dn && !cur.type) return;
  if (!cur.dn) {
    process.stderr.write('错误: --display-name 为必填参数\n');
    process.exit(1);
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
      process.stderr.write(`错误: --rootdata-id 必须是整数 (got ${cur.rid})\n`);
      process.exit(1);
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
      process.stderr.write(`错误: ${a} 缺少参数\n`);
      process.exit(1);
    }
    return argv[++i];
  };
  switch (a) {
    case '--manifest':       manifestPath = nextArg(); break;
    case '--model':          model = nextArg(); break;
    case '--max-turns':      maxTurnsCap = nextArg(); break;
    case '--max-budget':     maxBudgetCap = nextArg(); break;
    case '--parallel':       parallel = parseInt(nextArg(), 10); break;
    case '--i18n':           i18nArg = nextArg(); break;
    case '--i18n-parallel':  i18nParallel = parseInt(nextArg(), 10); break;
    case '--i18n-model':     i18nModel = nextArg(); break;
    case '--dry-run':        dryRun = true; break;
    case '--display-name':   cur.dn = nextArg(); break;
    case '--type':           cur.type = nextArg(); break;
    case '--slug':           cur.slug = nextArg(); break;
    case '--hints':          cur.hints = nextArg(); break;
    case '--rootdata-id':    cur.rid = nextArg(); break;
    case '--batch':          flush(); break;
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      process.exit(0);
    default:
      process.stderr.write(`未知参数: ${a}\n`);
      process.exit(1);
  }
}
flush();

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

// ── i18n label for header line ─────────────────────────────────────────────
let i18nLabel;
switch (i18nArg) {
  case '':     i18nLabel = 'skip (no --i18n flag — silent skip)'; break;
  case 'none': i18nLabel = 'skip'; break;
  case 'all':  i18nLabel = 'all languages (from manifest catalog)'; break;
  default:     i18nLabel = i18nArg;
}

const ROOTDATA_ENABLED = !!process.env.ROOTDATA_API_KEY;
const RUN_TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const runDir = join(SCRIPT_DIR, 'out', RUN_TS);

console.log('=== Protocol-info crawl ===');
console.log(`Providers:   ${providers.length}`);
console.log(`Model:       ${model || 'default'}`);
console.log(`Parallel:    ${parallel}`);
console.log(`RootData:    ${ROOTDATA_ENABLED ? 'enabled (Round 2)' : 'disabled (single-round)'}`);
console.log(`i18n:        ${i18nLabel} [model=${i18nModel || 'default'}, parallel=${i18nParallel}]`);
console.log(`Out dir:     ${runDir}`);
console.log('');

// Bail early if claude / node not available?  framework/cli/r1.mjs handles
// claude-bin discovery itself; we just trust the path.

await mkdir(runDir, { recursive: true });

try {
  await run({
    manifestPath,
    providers,
    runDir,
    parallelism: parallel,
    dryRun,
    options: {
      model,
      i18nArg,
      i18nParallel,
      i18nModel,
      maxTurns,
      maxBudget,
    },
  });
} catch (err) {
  process.stderr.write(`orchestrator failed: ${err.stack || err.message}\n`);
  process.exit(1);
}
