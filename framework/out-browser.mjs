// Static out/ browser generator.
//
// Writes a self-contained out/index.html so reviewers can inspect and copy
// key artifacts without walking the protocol-first directory tree.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log as gitLog } from './version-store.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(FRAMEWORK_DIR);
const DEFAULT_OUT_ROOT = join(SCRIPT_DIR, 'out');
const MAX_EMBED_BYTES = 1_500_000;
const RUN_ID_RE = /^\d{8}T\d{6}Z$/;

const ARTIFACTS = [
  { name: 'record.import.json', label: 'Import JSON', kind: 'json' },
  { name: 'record.json', label: 'Record', kind: 'json' },
  { name: 'record.full.json', label: 'Full i18n', kind: 'json' },
  { name: 'summary.tsv', label: 'Summary', kind: 'tsv' },
  { name: 'findings.json', label: 'Findings', kind: 'json' },
  { name: 'gaps.json', label: 'Gaps', kind: 'json' },
  { name: 'changes.json', label: 'Changes', kind: 'json' },
  { name: 'meta.json', label: 'Meta', kind: 'json' },
];

async function readTextIfSmall(path) {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    const tooLarge = s.size > MAX_EMBED_BYTES;
    return {
      size: s.size,
      tooLarge,
      content: tooLarge ? '' : await readFile(path, 'utf8'),
    };
  } catch {
    return null;
  }
}

function relPath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function hrefForRelPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function parseSummaryTsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

async function artifact(outputRoot, dir, def) {
  const absPath = join(dir, def.name);
  const text = await readTextIfSmall(absPath);
  if (!text) return null;
  const rel = relPath(outputRoot, absPath);
  return {
    name: def.name,
    label: def.label,
    kind: def.kind,
    path: absPath,
    relPath: rel,
    href: hrefForRelPath(rel),
    size: text.size,
    sizeLabel: sizeLabel(text.size),
    tooLarge: text.tooLarge,
    content: text.content,
  };
}

async function collectArtifacts(outputRoot, dir) {
  const out = [];
  for (const def of ARTIFACTS) {
    const a = await artifact(outputRoot, dir, def);
    if (a) out.push(a);
  }
  return out;
}

async function readProtocolRow(dir, slug) {
  const summary = await readTextIfSmall(join(dir, 'summary.tsv'));
  if (!summary || summary.tooLarge) return null;
  return parseSummaryTsv(summary.content).find((row) => row.slug === slug) || null;
}

async function readMetaStatus(dir) {
  const meta = await readTextIfSmall(join(dir, 'meta.json'));
  if (!meta || meta.tooLarge || !meta.content) return null;
  try {
    const parsed = JSON.parse(meta.content);
    return parsed?.status || null;
  } catch {
    return null;
  }
}

function normalizeRow(row, fallback = {}) {
  return {
    slug: row?.slug || fallback.slug || '',
    status: row?.status || fallback.status || '',
    members: row?.members || '-',
    funding: row?.funding || '-',
    audits: row?.audits || '-',
    schema: row?.schema || '-',
    source: row?.source || '-',
    api_status: row?.api_status || '-',
    i18n: row?.i18n || '-',
  };
}

export async function collectOutIndex(outDir = DEFAULT_OUT_ROOT) {
  const root = resolve(outDir);
  let dirEntries;
  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return { protocols: [], runsLog: [] };
  }

  const protocols = [];
  for (const ent of dirEntries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;          // .runs, .git, ...
    if (RUN_ID_RE.test(ent.name)) continue;          // legacy run-id dirs
    const dir = join(root, ent.name);
    const recordPath = join(dir, 'record.json');
    try {
      await stat(recordPath);
    } catch {
      continue;
    }
    protocols.push({
      slug: ent.name,
      recordPath,
      dir,
    });
  }
  for (const p of protocols) {
    try { p.history = await gitLog(root, { slug: p.slug, limit: 20 }); }
    catch { p.history = []; }
  }
  protocols.sort((a, b) => a.slug.localeCompare(b.slug));

  const runsLog = await readRunsLog(root);
  return { protocols, runsLog };
}

async function readRunsLog(outDir) {
  try {
    const body = await readFile(join(outDir, '.runs.log'), 'utf8');
    return body.trim().split('\n').filter(Boolean).map((line) => {
      const [ts, runId, slugs, outcome] = line.split('\t');
      return { ts, runId, slugs: (slugs || '').split(',').filter(Boolean), outcome };
    });
  } catch {
    return [];
  }
}

// Hydrate the protocols list from `collectOutIndex` with per-protocol
// artifacts, summary row, and meta status, in the protocols-first shape
// consumed by renderHtml.
async function hydrateView(outputRoot) {
  outputRoot = resolve(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const idx = await collectOutIndex(outputRoot);

  const hydrated = [];
  for (const p of idx.protocols) {
    const artifacts = await collectArtifacts(outputRoot, p.dir);
    const row = await readProtocolRow(p.dir, p.slug);
    const metaStatus = await readMetaStatus(p.dir);
    hydrated.push({
      slug: p.slug,
      dir: p.dir,
      relDir: relPath(outputRoot, p.dir),
      row: normalizeRow(row, { slug: p.slug, status: metaStatus || 'unknown' }),
      artifacts,
      history: p.history || [],
    });
  }
  hydrated.sort((a, b) => a.slug.localeCompare(b.slug));

  const okCount = hydrated.filter((p) => p.row?.status === 'OK').length;
  return {
    generatedAt: new Date().toISOString(),
    outputRoot,
    protocols: hydrated,
    runsLog: idx.runsLog,
    totals: {
      protocols: hydrated.length,
      ok: okCount,
      issues: Math.max(0, hydrated.length - okCount),
      runs: idx.runsLog.length,
    },
  };
}

function scriptJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export async function buildOutBrowser(outputRoot = DEFAULT_OUT_ROOT, opts = {}) {
  outputRoot = resolve(outputRoot);
  const data = await hydrateView(outputRoot);
  const outputFile = opts.outputFile ? resolve(opts.outputFile) : join(outputRoot, 'index.html');
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, renderHtml(data));
  return outputFile;
}

function renderHtml(data) {
  const okCount = data.totals.ok;
  const issueCount = data.totals.issues;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>protocol-info out</title>
<style>
:root {
  --canvas: #f6f5ef;
  --surface: #fffefa;
  --surface-soft: #f0f3ec;
  --surface-warm: #f8f3e9;
  --ink: #23241f;
  --muted: #74746a;
  --faint: #9a9b91;
  --line: #dddcd1;
  --line-strong: #bfc3b7;
  --accent: #2f6b5f;
  --accent-soft: #e4eee8;
  --green: #236b45;
  --green-bg: #e5f0e7;
  --red: #9d463e;
  --red-bg: #f4e3df;
  --amber: #976a2b;
  --amber-bg: #f1e7d2;
  --blue: #315f78;
  --blue-bg: #e2ebef;
  --code: #151711;
  --code-line: #2c3027;
  --mono: "SFMono-Regular", "Cascadia Mono", "Liberation Mono", Menlo, monospace;
  --title: Optima, "Avenir Next", "Hiragino Sans", sans-serif;
  --sans: "Hiragino Sans", "Yu Gothic", "Avenir Next", sans-serif;
}
* { box-sizing: border-box; }
html { color-scheme: light; }
body {
  margin: 0;
  color: var(--ink);
  background:
    linear-gradient(90deg, rgba(35,36,31,.025) 1px, transparent 1px) 0 0 / 48px 48px,
    var(--canvas);
  font-family: var(--sans);
  font-size: 14px;
}
button, input, select { font: inherit; }
button, a, input, select { outline-color: var(--blue); }
::selection { background: var(--accent-soft); color: var(--ink); }
.shell { min-height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.topbar {
  min-height: 62px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--line);
  background: rgba(246, 245, 239, .94);
  backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 5;
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 14px;
}
.identity {
  min-width: 154px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.product {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.view-name {
  font-family: var(--title);
  font-size: 18px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.rootline {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
}
code, pre { font-family: var(--mono); }
.generated { white-space: nowrap; }
.statbar {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.stat {
  min-height: 30px;
  padding: 4px 9px;
  border: 1px solid var(--line);
  background: rgba(255,254,250,.72);
  border-radius: 999px;
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
}
.stat span {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .09em;
}
.stat strong {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1;
}
.pill {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  min-height: 30px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  background: rgba(255,254,250,.72);
  border-radius: 999px;
  color: var(--ink);
}
.pill code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layout {
  display: grid;
  grid-template-columns: minmax(220px, 260px) minmax(430px, .95fr) minmax(420px, 1.15fr);
  gap: 12px;
  padding: 12px 14px 16px;
  align-items: start;
}
.rail, .list, .detail {
  border: 1px solid var(--line);
  background: rgba(255,254,250,.86);
  min-width: 0;
  border-radius: 8px;
}
.rail, .list {
  height: calc(100vh - 90px);
  overflow: auto;
  padding: 12px;
}
.detail {
  padding: 14px;
  position: sticky;
  top: 76px;
  height: calc(100vh - 92px);
  display: flex;
  flex-direction: column;
}
.panel-head {
  position: sticky;
  top: -12px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: -12px -12px 12px;
  padding: 11px 12px 9px;
  border-bottom: 1px solid var(--line);
  background: rgba(255,254,250,.95);
  backdrop-filter: blur(8px);
}
.section-title {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .12em;
}
.count {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.run-button, .protocol-row, .artifact-tab, .action {
  border: 1px solid transparent;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.run-button {
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  margin-bottom: 4px;
}
.run-button:hover, .protocol-row:hover, .artifact-tab:hover, .action:hover {
  border-color: var(--line-strong);
  background: var(--surface-soft);
}
.run-button:active, .protocol-row:active, .artifact-tab:active, .action:active { background: var(--accent-soft); }
.run-button.active, .protocol-row.active, .artifact-tab.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}
.run-id { display: block; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.run-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; color: var(--muted); font-size: 11px; }
.filters { display: grid; grid-template-columns: 1fr 142px; gap: 8px; margin-bottom: 10px; }
.filters input, .filters select {
  min-height: 36px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
}
.filters input:focus, .filters select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.bulk { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
.table-head {
  display: grid;
  grid-template-columns: minmax(110px, 1.2fr) 84px repeat(4, minmax(42px, .45fr));
  gap: 8px;
  padding: 0 10px 7px;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .09em;
}
.protocol-row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(110px, 1.2fr) 84px repeat(4, minmax(42px, .45fr));
  gap: 8px;
  align-items: center;
  min-height: 44px;
  padding: 8px 10px;
  margin-bottom: 4px;
  text-align: left;
}
.slug { font-family: var(--mono); font-weight: 700; overflow-wrap: anywhere; }
.status {
  display: inline-flex;
  justify-content: center;
  padding: 3px 7px;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 10px;
  border: 1px solid currentColor;
}
.status.ok { color: var(--green); background: var(--green-bg); }
.status.fail { color: var(--red); background: var(--red-bg); }
.status.other { color: var(--amber); background: var(--amber-bg); }
.metric { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--line);
}
.detail h2 {
  margin: 0;
  font-family: var(--title);
  font-size: 24px;
  line-height: 1.05;
  letter-spacing: .01em;
}
.subpath { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.record-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin: 8px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.fact {
  border: 0;
  border-left: 1px solid var(--line);
  background: transparent;
  padding: 8px 9px;
  min-width: 0;
}
.fact:first-child { border-left: 0; }
.fact span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }
.fact strong { display: block; margin-top: 4px; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 7px 0; }
.artifact-tab {
  padding: 6px 9px;
  border-color: var(--line);
  background: var(--surface);
  font-size: 12px;
  color: var(--ink);
}
.actions { display: flex; gap: 7px; flex-wrap: wrap; margin: 7px 0 10px; }
.action {
  min-height: 32px;
  padding: 6px 10px;
  border-color: var(--line);
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
}
.action.primary { background: var(--accent); color: #fffefa; border-color: var(--accent); }
.action:disabled { color: var(--muted); cursor: not-allowed; opacity: .65; }
.compare-panel {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  background: transparent;
  padding: 10px 0;
  margin: 0 0 10px;
}
.compare-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.compare-title {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .12em;
}
.compare-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  align-items: end;
}
.compare-controls label {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .08em;
}
.compare-controls select {
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  font-size: 12px;
}
.compare-toggle {
  margin: 7px 0 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 12px;
}
.compare-toggle input { margin: 0; }
.diff-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-top: 8px;
}
.diff-stat {
  border: 1px solid var(--line);
  background: var(--surface-soft);
  padding: 6px 8px;
  border-radius: 999px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11px;
}
.diff-list {
  margin-top: 8px;
  max-height: 210px;
  overflow: auto;
  display: grid;
  gap: 6px;
}
.diff-item {
  border: 1px solid var(--line);
  background: rgba(255,254,250,.74);
  border-radius: 6px;
  padding: 7px;
}
.diff-path {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: var(--mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.diff-type {
  min-width: 64px;
  text-align: center;
  padding: 2px 5px;
  border-radius: 4px;
  border: 1px solid currentColor;
  font-size: 10px;
  text-transform: uppercase;
}
.diff-type.added { color: var(--green); background: var(--green-bg); }
.diff-type.removed { color: var(--red); background: var(--red-bg); }
.diff-type.changed { color: var(--blue); background: var(--blue-bg); }
.diff-values {
  margin-top: 6px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.diff-value {
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid var(--code-line);
  border-radius: 5px;
  background: var(--code);
  color: #eff0e7;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 150px;
  overflow: auto;
}
.preview-wrap {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--code-line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--code);
}
.preview-top {
  min-height: 32px;
  padding: 7px 11px;
  color: #bfc7b7;
  background: #1d211a;
  border-bottom: 1px solid var(--code-line);
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-family: var(--mono);
  font-size: 11px;
}
.preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 14px;
  background: var(--code);
  color: #f2f3e9;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}
.empty {
  padding: 18px;
  border: 1px dashed var(--line);
  color: var(--muted);
  background: rgba(255,254,250,.54);
  border-radius: 6px;
}
.toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  padding: 10px 12px;
  background: var(--ink);
  color: var(--surface);
  border-radius: 6px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity .18s ease, transform .18s ease;
  z-index: 10;
}
.toast.show { opacity: 1; transform: translateY(0); }
@media (max-width: 1100px) {
  .topbar { grid-template-columns: auto minmax(0, 1fr) auto; }
  .statbar { grid-column: 1 / -1; justify-content: flex-start; overflow: auto; padding-top: 2px; }
  .layout { grid-template-columns: 220px 1fr; }
  .rail, .list { height: auto; max-height: none; }
  .detail { grid-column: 1 / -1; position: static; height: 620px; }
}
@media (max-width: 760px) {
  .topbar {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 10px;
    padding: 10px;
  }
  .identity { min-width: 0; }
  .product { font-size: 10px; }
  .view-name { font-size: 16px; }
  .topbar > .action {
    grid-column: 2;
    grid-row: 1;
    min-height: 32px;
    padding: 5px 10px;
  }
  .rootline {
    grid-column: 1 / -1;
    display: block;
  }
  .generated { display: none; }
  .pill { width: 100%; justify-content: center; }
  .statbar {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
  }
  .stat {
    justify-content: center;
    gap: 5px;
    min-height: 28px;
    padding: 3px 5px;
  }
  .stat span { font-size: 9px; }
  .layout { grid-template-columns: 1fr; padding: 10px; }
  .rail, .list { height: auto; }
  .filters { grid-template-columns: 1fr; }
  .table-head { display: none; }
  .protocol-row { grid-template-columns: 1fr 86px; }
  .protocol-row .metric { display: none; }
  .record-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fact:nth-child(odd) { border-left: 0; }
  .fact:nth-child(n + 3) { border-top: 1px solid var(--line); }
  .compare-controls { grid-template-columns: 1fr; }
  .diff-values { grid-template-columns: 1fr; }
  .detail { height: 620px; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="identity">
      <span class="product">protocol-info</span>
      <strong class="view-name">out</strong>
    </div>
    <div class="rootline">
      <span class="generated">Generated <code>${data.generatedAt}</code></span>
      <span class="pill"><code>${escapeHtml(data.outputRoot)}</code></span>
    </div>
    <div class="statbar">
      <div class="stat"><span>Runs</span><strong>${data.totals.runs}</strong></div>
      <div class="stat"><span>Records</span><strong>${data.totals.protocols}</strong></div>
      <div class="stat"><span>OK</span><strong>${okCount}</strong></div>
      <div class="stat"><span>Issues</span><strong>${issueCount}</strong></div>
    </div>
    <button class="action" id="copy-root">Copy root</button>
  </header>
  <main class="layout">
    <aside class="rail">
      <div class="panel-head"><p class="section-title">Protocols</p><span class="count">${data.totals.protocols}</span></div>
      <ul class="protocols-list" id="protocols-nav"></ul>
      <details class="runs-filter">
        <summary>Filter by recent run</summary>
        <ul id="runs-filter-list"></ul>
      </details>
    </aside>
    <section class="list">
      <div class="panel-head"><p class="section-title">Records</p><span class="count" id="record-count"></span></div>
      <div class="filters">
        <input id="query" placeholder="Filter slug or status">
        <select id="status">
          <option value="all">All statuses</option>
          <option value="OK">OK</option>
          <option value="SCHEMA_FAIL">SCHEMA_FAIL</option>
          <option value="CRAWL_FAIL">CRAWL_FAIL</option>
        </select>
      </div>
      <div class="bulk">
        <button class="action primary" id="copy-imports">Copy visible import JSON</button>
        <button class="action" id="copy-summary">Copy run summary</button>
      </div>
      <div class="table-head">
        <span>Slug</span><span>Status</span><span>Members</span><span>Funding</span><span>Audits</span><span>i18n</span>
      </div>
      <div id="protocols"></div>
    </section>
    <section class="detail" id="detail"></section>
  </main>
</div>
<div class="toast" id="toast"></div>
<script id="out-data" type="application/json">${scriptJson(data)}</script>
<script>
const DATA = JSON.parse(document.getElementById('out-data').textContent);
const state = {
  slug: DATA.protocols[0]?.slug || '',
  artifact: 'record.import.json',
  compareBaseRun: '',
  compareTargetRun: '',
  compareArtifact: 'record.import.json',
  ignoreVolatile: true,
  query: '',
  status: 'all',
  runFilter: ''
};

const $ = (id) => document.getElementById(id);

function visibleProtocols() {
  const q = state.query.trim().toLowerCase();
  let pool = DATA.protocols;
  if (state.runFilter) {
    const entry = (DATA.runsLog || []).find((r) => r.runId === state.runFilter);
    const slugs = entry ? new Set(entry.slugs) : null;
    if (slugs) pool = pool.filter((p) => slugs.has(p.slug));
  }
  return pool.filter((p) => {
    const status = p.row?.status || '';
    const haystack = [p.slug, status, p.row?.source, p.row?.api_status].join(' ').toLowerCase();
    return (!q || haystack.includes(q)) && (state.status === 'all' || status === state.status);
  });
}

function selectedProtocol() {
  const protocols = visibleProtocols();
  return protocols.find((p) => p.slug === state.slug) || protocols[0] || null;
}

function selectedArtifact(protocol) {
  if (!protocol) return null;
  return protocol.artifacts.find((a) => a.name === state.artifact)
    || protocol.artifacts.find((a) => a.name === 'record.import.json')
    || protocol.artifacts[0]
    || null;
}

function protocolRuns(slug) {
  // v2.0: only the current snapshot is available; multi-run comparison
  // is handled via git commits in Task 13.
  const p = DATA.protocols.find((x) => x.slug === slug);
  return p ? [p] : [];
}

function protocolForRun(slug /*, runId */) {
  return DATA.protocols.find((p) => p.slug === slug) || null;
}

function artifactFor(protocol, name) {
  return protocol?.artifacts.find((a) => a.name === name) || null;
}

function compareArtifactNames(runs) {
  const names = new Set();
  for (const protocol of runs) {
    for (const artifact of protocol.artifacts || []) {
      if (artifact.kind === 'json') names.add(artifact.name);
    }
  }
  const preferred = ['record.import.json', 'record.json', 'record.full.json', 'findings.json', 'gaps.json', 'changes.json', 'meta.json'];
  return preferred.filter((name) => names.has(name)).concat([...names].filter((name) => !preferred.includes(name)).sort());
}

function ensureCompareState(slug) {
  return protocolRuns(slug);
}

function statusClass(status) {
  if (status === 'OK') return 'ok';
  if (String(status).includes('FAIL')) return 'fail';
  return 'other';
}

function renderProtocolsNav() {
  const node = $('protocols-nav');
  if (!node) return;
  if (DATA.protocols.length === 0) {
    node.innerHTML = '<li class="empty">No protocols found.</li>';
    return;
  }
  node.innerHTML = DATA.protocols.map((p) => {
    const active = p.slug === state.slug ? ' active' : '';
    const histCount = (p.history || []).length;
    return '<li><button class="run-button' + active + '" data-nav-slug="' + esc(p.slug) + '">' +
      '<span class="run-id">' + esc(p.slug) + '</span>' +
      '<span class="run-meta"><span>' + histCount + ' commits</span><span>' + esc(p.row?.status || '-') + '</span></span>' +
      '</button></li>';
  }).join('');
  node.querySelectorAll('[data-nav-slug]').forEach((button) => {
    button.addEventListener('click', () => {
      state.slug = button.dataset.navSlug;
      state.artifact = 'record.import.json';
      render();
    });
  });
}

function renderRunsFilter() {
  const node = $('runs-filter-list');
  if (!node) return;
  const entries = (DATA.runsLog || []).slice(-20).reverse();
  if (entries.length === 0) {
    node.innerHTML = '<li class="empty">No runs logged.</li>';
    return;
  }
  const clearItem = state.runFilter
    ? '<li><button class="run-button" data-run-filter="">clear filter</button></li>'
    : '';
  node.innerHTML = clearItem + entries.map((r) => {
    const active = r.runId === state.runFilter ? ' active' : '';
    return '<li><button class="run-button' + active + '" data-run-filter="' + esc(r.runId) + '">' +
      '<span class="run-id">' + esc(r.runId) + '</span>' +
      '<span class="run-meta"><span>' + esc(r.outcome || '') + '</span><span>' + (r.slugs?.length || 0) + '</span></span>' +
      '</button></li>';
  }).join('');
  node.querySelectorAll('[data-run-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.runFilter = button.dataset.runFilter;
      render();
    });
  });
}

function renderProtocols() {
  const node = $('protocols');
  const protocols = visibleProtocols();
  const countNode = $('record-count');
  if (countNode) countNode.textContent = protocols.length + ' visible';
  if (protocols.length === 0) {
    node.innerHTML = '<div class="empty">No records match the current filter.</div>';
    return;
  }
  const selected = selectedProtocol();
  state.slug = selected?.slug || state.slug;
  node.innerHTML = protocols.map((p) => {
    const row = p.row || {};
    const active = p.slug === state.slug ? ' active' : '';
    const cls = statusClass(row.status);
    return '<button class="protocol-row' + active + '" data-slug="' + esc(p.slug) + '">' +
      '<span class="slug">' + esc(p.slug) + '</span>' +
      '<span class="status ' + cls + '">' + esc(row.status || '-') + '</span>' +
      '<span class="metric">members ' + esc(row.members || '-') + '</span>' +
      '<span class="metric">funding ' + esc(row.funding || '-') + '</span>' +
      '<span class="metric">audits ' + esc(row.audits || '-') + '</span>' +
      '<span class="metric">i18n ' + esc(row.i18n || '-') + '</span>' +
      '</button>';
  }).join('');
  node.querySelectorAll('[data-slug]').forEach((button) => {
    button.addEventListener('click', () => {
      state.slug = button.dataset.slug;
      state.artifact = 'record.import.json';
      render();
    });
  });
}

function renderDetail() {
  const node = $('detail');
  const protocol = selectedProtocol();
  if (!protocol) {
    node.innerHTML = '<div class="empty">Select a run or record.</div>';
    return;
  }
  const artifact = selectedArtifact(protocol);
  state.artifact = artifact?.name || state.artifact;
  const tabs = protocol.artifacts.map((a) => {
    const active = a.name === state.artifact ? ' active' : '';
    return '<button class="artifact-tab' + active + '" data-artifact="' + esc(a.name) + '">' +
      esc(a.label) + ' <span class="metric">' + esc(a.sizeLabel) + '</span></button>';
  }).join('');
  const content = artifact
    ? artifact.tooLarge
      ? 'File is too large to embed in this static page. Use Copy path or Open.'
      : artifact.content
    : 'No artifacts found for this record.';
  const compare = buildComparePanel(protocol);
  const history = Array.isArray(protocol.history) ? protocol.history : [];
  const historyHtml = history.length === 0
    ? ''
    : '<section class="history"><h3>History (' + history.length + ')</h3><ul>' +
        history.map((h) =>
          '<li><code>' + esc(h.sha) + '</code> ' + esc(String(h.ts || '').slice(0, 16)) +
          ' — ' + esc(h.message || '') +
          ' <span class="run-id">' + esc(h.runId || '') + '</span></li>'
        ).join('') +
        '</ul></section>';
  node.innerHTML =
    '<div class="detail-head">' +
      '<div><h2>' + esc(protocol.slug) + '</h2><div class="subpath">' + esc(protocol.relDir || '-') + '</div></div>' +
      '<span class="status ' + statusClass(protocol.row?.status) + '">' + esc(protocol.row?.status || '-') + '</span>' +
    '</div>' +
    '<div class="record-facts">' +
      '<div class="fact"><span>Members</span><strong>' + esc(protocol.row?.members || '-') + '</strong></div>' +
      '<div class="fact"><span>Funding</span><strong>' + esc(protocol.row?.funding || '-') + '</strong></div>' +
      '<div class="fact"><span>Audits</span><strong>' + esc(protocol.row?.audits || '-') + '</strong></div>' +
      '<div class="fact"><span>i18n</span><strong>' + esc(protocol.row?.i18n || '-') + '</strong></div>' +
    '</div>' +
    '<div class="tabs">' + tabs + '</div>' +
    '<div class="actions">' +
      '<button class="action primary" id="copy-content" ' + (!artifact || artifact.tooLarge ? 'disabled' : '') + '>Copy content</button>' +
      '<button class="action" id="copy-path" ' + (!artifact ? 'disabled' : '') + '>Copy path</button>' +
      (artifact ? '<a class="action" href="' + esc(artifact.href) + '" target="_blank" rel="noreferrer">Open file</a>' : '') +
    '</div>' +
    historyHtml +
    compare.html +
    '<div class="preview-wrap">' +
      '<div class="preview-top"><span>' + esc(artifact?.name || 'no file') + '</span><span>' + esc(artifact?.sizeLabel || '') + '</span></div>' +
      '<pre class="preview"><code>' + esc(content) + '</code></pre>' +
    '</div>';
  node.querySelectorAll('[data-artifact]').forEach((button) => {
    button.addEventListener('click', () => {
      state.artifact = button.dataset.artifact;
      renderDetail();
    });
  });
  const copyContent = $('copy-content');
  if (copyContent && artifact && !artifact.tooLarge) {
    copyContent.addEventListener('click', () => copyText(artifact.content, artifact.name));
  }
  const copyPath = $('copy-path');
  if (copyPath && artifact) {
    copyPath.addEventListener('click', () => copyText(artifact.path, artifact.name + ' path'));
  }
  bindComparePanel(compare.summary);
}

function buildComparePanel(protocol) {
  const runs = ensureCompareState(protocol.slug);
  if (runs.length < 2) {
    return {
      html: '<div class="compare-panel"><div class="compare-head"><span class="compare-title">Compare runs</span></div><div class="empty">Need at least two runs for this protocol.</div></div>',
      summary: '',
    };
  }

  const artifactNames = compareArtifactNames(runs);
  const baseProtocol = protocolForRun(protocol.slug, state.compareBaseRun);
  const targetProtocol = protocolForRun(protocol.slug, state.compareTargetRun);
  const baseArtifact = artifactFor(baseProtocol, state.compareArtifact);
  const targetArtifact = artifactFor(targetProtocol, state.compareArtifact);
  const result = diffArtifacts({
    slug: protocol.slug,
    artifactName: state.compareArtifact,
    baseRun: state.compareBaseRun,
    targetRun: state.compareTargetRun,
    baseArtifact,
    targetArtifact,
    ignoreVolatile: state.ignoreVolatile,
  });

  const runOptions = runs.map((p) =>
    '<option value="' + esc(p.runId) + '">' + esc(p.runId) + '</option>'
  ).join('');
  const artifactOptions = artifactNames.map((name) =>
    '<option value="' + esc(name) + '">' + esc(name) + '</option>'
  ).join('');
  const diffs = result.diffs.slice(0, 40);
  const diffHtml = result.error
    ? '<div class="empty">' + esc(result.error) + '</div>'
    : diffs.length === 0
      ? '<div class="empty">No meaningful JSON differences.</div>'
      : diffs.map(renderDiffItem).join('') + (result.diffs.length > diffs.length ? '<div class="empty">' + (result.diffs.length - diffs.length) + ' more differences. Copy the summary for the full list.</div>' : '');

  const html =
    '<div class="compare-panel">' +
      '<div class="compare-head">' +
        '<span class="compare-title">Compare runs</span>' +
        '<button class="action" id="copy-diff" ' + (result.error ? 'disabled' : '') + '>Copy diff</button>' +
      '</div>' +
      '<div class="compare-controls">' +
        '<label>Base run<select id="compare-base">' + runOptions + '</select></label>' +
        '<label>Compare run<select id="compare-target">' + runOptions + '</select></label>' +
        '<label>Artifact<select id="compare-artifact">' + artifactOptions + '</select></label>' +
      '</div>' +
      '<label class="compare-toggle"><input type="checkbox" id="compare-ignore" ' + (state.ignoreVolatile ? 'checked' : '') + '> Ignore volatile fields</label>' +
      '<div class="diff-stats">' +
        '<div class="diff-stat"><span>Added</span><strong>' + result.counts.added + '</strong></div>' +
        '<div class="diff-stat"><span>Removed</span><strong>' + result.counts.removed + '</strong></div>' +
        '<div class="diff-stat"><span>Changed</span><strong>' + result.counts.changed + '</strong></div>' +
      '</div>' +
      '<div class="diff-list">' + diffHtml + '</div>' +
    '</div>';

  return { html, summary: result.summary };
}

function bindComparePanel(summary) {
  const base = $('compare-base');
  if (base) {
    base.value = state.compareBaseRun;
    base.addEventListener('change', () => {
      state.compareBaseRun = base.value;
      renderDetail();
    });
  }
  const target = $('compare-target');
  if (target) {
    target.value = state.compareTargetRun;
    target.addEventListener('change', () => {
      state.compareTargetRun = target.value;
      renderDetail();
    });
  }
  const artifact = $('compare-artifact');
  if (artifact) {
    artifact.value = state.compareArtifact;
    artifact.addEventListener('change', () => {
      state.compareArtifact = artifact.value;
      renderDetail();
    });
  }
  const ignore = $('compare-ignore');
  if (ignore) {
    ignore.checked = state.ignoreVolatile;
    ignore.addEventListener('change', () => {
      state.ignoreVolatile = ignore.checked;
      renderDetail();
    });
  }
  const copy = $('copy-diff');
  if (copy && summary) copy.addEventListener('click', () => copyText(summary, 'diff summary'));
}

function renderDiffItem(diff) {
  const type = esc(diff.type);
  const before = diff.type === 'added' ? '' : '<div class="diff-value">' + esc(formatValue(diff.before)) + '</div>';
  const after = diff.type === 'removed' ? '' : '<div class="diff-value">' + esc(formatValue(diff.after)) + '</div>';
  return '<div class="diff-item">' +
    '<div class="diff-path"><span class="diff-type ' + type + '">' + type + '</span><span>' + esc(diff.path || '(root)') + '</span></div>' +
    '<div class="diff-values">' + before + after + '</div>' +
    '</div>';
}

function render() {
  renderProtocolsNav();
  renderRunsFilter();
  renderProtocols();
  renderDetail();
}

function diffArtifacts({ slug, artifactName, baseRun, targetRun, baseArtifact, targetArtifact, ignoreVolatile }) {
  const emptyCounts = { added: 0, removed: 0, changed: 0 };
  if (!baseArtifact || !targetArtifact) {
    return {
      diffs: [],
      counts: emptyCounts,
      summary: '',
      error: 'Both runs must contain ' + artifactName + '.',
    };
  }
  if (baseArtifact.tooLarge || targetArtifact.tooLarge) {
    return {
      diffs: [],
      counts: emptyCounts,
      summary: '',
      error: 'One side is too large to compare in the static page.',
    };
  }

  let baseJson, targetJson;
  try {
    baseJson = JSON.parse(baseArtifact.content);
    targetJson = JSON.parse(targetArtifact.content);
  } catch (err) {
    return {
      diffs: [],
      counts: emptyCounts,
      summary: '',
      error: 'Selected artifact is not valid JSON: ' + err.message,
    };
  }

  const base = normalizeCompareJson(baseJson, artifactName);
  const target = normalizeCompareJson(targetJson, artifactName);
  const diffs = [];
  walkDiff(base, target, '', diffs, { ignoreVolatile });
  diffs.sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.path.localeCompare(b.path));
  const counts = diffs.reduce((acc, diff) => {
    acc[diff.type] += 1;
    return acc;
  }, { ...emptyCounts });

  return {
    diffs,
    counts,
    error: '',
    summary: formatDiffSummary({ slug, artifactName, baseRun, targetRun, diffs, counts, ignoreVolatile }),
  };
}

function normalizeCompareJson(json, artifactName) {
  if (artifactName === 'record.import.json' && Array.isArray(json?.data)) {
    return json.data.find((entry) => entry?.locale === 'en') || json.data[0] || {};
  }
  return json;
}

function walkDiff(before, after, path, diffs, options) {
  if (options.ignoreVolatile && isVolatilePath(path)) return;
  if (before === undefined && after !== undefined) {
    diffs.push({ type: 'added', path, after });
    return;
  }
  if (before !== undefined && after === undefined) {
    diffs.push({ type: 'removed', path, before });
    return;
  }
  const beforeKind = valueKind(before);
  const afterKind = valueKind(after);
  if (beforeKind !== afterKind) {
    diffs.push({ type: 'changed', path, before, after });
    return;
  }
  if (beforeKind === 'array') {
    walkArrayDiff(before, after, path, diffs, options);
    return;
  }
  if (beforeKind === 'object') {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      walkDiff(before[key], after[key], path ? path + '.' + key : key, diffs, options);
    }
    return;
  }
  if (!Object.is(before, after)) {
    diffs.push({ type: 'changed', path, before, after });
  }
}

function walkArrayDiff(before, after, path, diffs, options) {
  const identity = arrayIdentity(path, before, after);
  if (!identity) {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      walkDiff(before[i], after[i], path + '[' + i + ']', diffs, options);
    }
    return;
  }

  const beforeMap = mapArrayByIdentity(before, identity);
  const afterMap = mapArrayByIdentity(after, identity);
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  for (const key of keys) {
    walkDiff(beforeMap.get(key), afterMap.get(key), path + '[' + key + ']', diffs, options);
  }
}

function arrayIdentity(path, before, after) {
  const all = [...before, ...after];
  if (all.length === 0 || !all.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return null;
  if (path === 'members' && all.every((item) => item.memberName)) {
    return (item) => 'memberName=' + String(item.memberName);
  }
  if (path === 'fundingRounds' && all.every((item) => item.round || item.date)) {
    return (item) => 'round=' + String(item.round || '') + '|date=' + String(item.date || '');
  }
  if (path === 'audits.items' && all.every((item) => item.auditor || item.date || item.scope)) {
    return (item) => 'auditor=' + String(item.auditor || '') + '|date=' + String(item.date || '') + '|scope=' + String(item.scope || '');
  }
  return null;
}

function mapArrayByIdentity(arr, identity) {
  const out = new Map();
  arr.forEach((item, index) => {
    const key = identity(item, index).replace(/[\\[\\]]/g, '_');
    out.set(key || String(index), item);
  });
  return out;
}

function valueKind(value) {
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'primitive';
}

function isVolatilePath(path) {
  if (!path) return false;
  return path === 'exportedAt'
    || path.endsWith('.exportedAt')
    || path === 'audits.lastScannedAt'
    || path.endsWith('.audits.lastScannedAt')
    || path === 'budget'
    || path.startsWith('budget.')
    || path === 'r1.cost_usd'
    || path === 'r2.cost_usd'
    || path.endsWith('.cost_usd')
    || path === 'i18n.cost_usd'
    || path === 'generatedAt';
}

function typeRank(type) {
  return type === 'added' ? 0 : type === 'removed' ? 1 : 2;
}

function formatValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) return 'undefined';
  return text.length > 1200 ? text.slice(0, 1200) + '\\n... truncated ...' : text;
}

function formatDiffSummary({ slug, artifactName, baseRun, targetRun, diffs, counts, ignoreVolatile }) {
  const lines = [
    slug + ' / ' + artifactName,
    'base:    ' + baseRun,
    'compare: ' + targetRun,
    'ignore volatile: ' + (ignoreVolatile ? 'yes' : 'no'),
    'added=' + counts.added + ' removed=' + counts.removed + ' changed=' + counts.changed,
    '',
  ];
  for (const diff of diffs) {
    lines.push(diff.type.toUpperCase() + ' ' + (diff.path || '(root)'));
    if (diff.type !== 'added') lines.push('before: ' + oneLineValue(diff.before));
    if (diff.type !== 'removed') lines.push('after:  ' + oneLineValue(diff.after));
    lines.push('');
  }
  return lines.join('\\n');
}

function oneLineValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > 500 ? text.slice(0, 500) + '...' : text;
}

function copyVisibleImports() {
  const artifacts = visibleProtocols()
    .map((p) => p.artifacts.find((a) => a.name === 'record.import.json'))
    .filter((a) => a && !a.tooLarge && a.content);
  const envelopes = [];
  const data = [];
  for (const artifact of artifacts) {
    try {
      const parsed = JSON.parse(artifact.content);
      envelopes.push(parsed);
      if (Array.isArray(parsed.data)) data.push(...parsed.data);
    } catch {}
  }
  if (envelopes.length > 0) {
    const merged = {
      version: envelopes[0]?.version || '1.0',
      exportedAt: new Date().toISOString(),
      data,
    };
    copyText(JSON.stringify(merged, null, 2), data.length + ' import records');
    return;
  }
  copyText('', 'visible import JSON');
}

function copyRunSummary() {
  // Build a TSV-shaped summary across visible protocols.
  const rows = visibleProtocols().map((p) => p.row || {});
  if (rows.length === 0) return copyText('', 'run summary');
  const headers = ['slug', 'status', 'members', 'funding', 'audits', 'schema', 'source', 'api_status', 'i18n'];
  const tsv = [headers.join('\\t')]
    .concat(rows.map((r) => headers.map((h) => r[h] ?? '').join('\\t')))
    .join('\\n');
  copyText(tsv, 'run summary');
}

async function copyText(text, label) {
  if (!text) return toast('Nothing to copy');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied ' + label);
  } catch {
    toast('Copy failed');
  }
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1600);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

$('query').addEventListener('input', (event) => {
  state.query = event.target.value;
  renderProtocols();
  renderDetail();
});
$('status').addEventListener('change', (event) => {
  state.status = event.target.value;
  renderProtocols();
  renderDetail();
});
$('copy-root').addEventListener('click', () => copyText(DATA.outputRoot, 'output root'));
$('copy-imports').addEventListener('click', copyVisibleImports);
$('copy-summary').addEventListener('click', copyRunSummary);
render();
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputRoot = arg('out', DEFAULT_OUT_ROOT);
  const outputFile = arg('output', join(outputRoot, 'index.html'));
  const file = await buildOutBrowser(outputRoot, { outputFile });
  process.stdout.write(`${file}\n`);
}
