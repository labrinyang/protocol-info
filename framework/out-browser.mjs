// Static out/ browser generator.
//
// Writes a self-contained out/index.html so reviewers can inspect and copy
// key artifacts without walking the protocol-first directory tree.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(FRAMEWORK_DIR);
const DEFAULT_OUT_ROOT = join(SCRIPT_DIR, 'out');
const MAX_EMBED_BYTES = 1_500_000;

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

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

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

function ensureRun(map, runId) {
  if (!map.has(runId)) {
    map.set(runId, { runId, summary: null, rows: [], protocols: [] });
  }
  return map.get(runId);
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

export async function collectOutIndex(outputRoot = DEFAULT_OUT_ROOT) {
  await mkdir(outputRoot, { recursive: true });
  const runs = new Map();

  const runIndexRoot = join(outputRoot, '_runs');
  for (const ent of await entries(runIndexRoot)) {
    if (!ent.isDirectory()) continue;
    const runId = ent.name;
    const run = ensureRun(runs, runId);
    const summaryPath = join(runIndexRoot, runId, 'summary.tsv');
    const summary = await readTextIfSmall(summaryPath);
    if (summary) {
      const rel = relPath(outputRoot, summaryPath);
      run.summary = {
        path: summaryPath,
        relPath: rel,
        href: hrefForRelPath(rel),
        size: summary.size,
        sizeLabel: sizeLabel(summary.size),
        content: summary.tooLarge ? '' : summary.content,
      };
      run.rows = summary.tooLarge ? [] : parseSummaryTsv(summary.content);
    }
  }

  for (const slugEnt of await entries(outputRoot)) {
    if (!slugEnt.isDirectory() || slugEnt.name === '_runs') continue;
    if (slugEnt.name.startsWith('.')) continue;
    const slug = slugEnt.name;
    const slugRoot = join(outputRoot, slug);
    for (const runEnt of await entries(slugRoot)) {
      if (!runEnt.isDirectory()) continue;
      const runId = runEnt.name;
      const dir = join(slugRoot, runId);
      const artifacts = await collectArtifacts(outputRoot, dir);
      if (artifacts.length === 0) continue;
      const run = ensureRun(runs, runId);
      const row = await readProtocolRow(dir, slug);
      const metaStatus = await readMetaStatus(dir);
      run.protocols.push({
        slug,
        runId,
        dir,
        relDir: relPath(outputRoot, dir),
        row: normalizeRow(row, { slug, status: metaStatus || 'unknown' }),
        artifacts,
      });
    }
  }

  for (const run of runs.values()) {
    const seen = new Set(run.protocols.map((p) => p.slug));
    for (const row of run.rows) {
      if (seen.has(row.slug)) continue;
      run.protocols.push({
        slug: row.slug,
        runId: run.runId,
        dir: '',
        relDir: '',
        row: normalizeRow(row),
        artifacts: [],
      });
    }
    run.protocols.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  const runList = [...runs.values()]
    .sort((a, b) => b.runId.localeCompare(a.runId));

  return {
    generatedAt: new Date().toISOString(),
    outputRoot,
    runs: runList,
    totals: {
      runs: runList.length,
      protocols: runList.reduce((sum, run) => sum + run.protocols.length, 0),
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
  const data = await collectOutIndex(outputRoot);
  const outputFile = opts.outputFile || join(outputRoot, 'index.html');
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, renderHtml(data));
  return outputFile;
}

function renderHtml(data) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>protocol-info out</title>
<style>
:root {
  --paper: #f4f0e7;
  --ink: #191713;
  --muted: #726a5c;
  --line: #d8cfbd;
  --panel: #fffaf0;
  --panel-2: #e9e0cd;
  --green: #1f7a4f;
  --red: #b64236;
  --amber: #b76f1f;
  --blue: #245f8f;
  --shadow: 0 18px 45px rgba(25, 23, 19, .12);
  --mono: "SFMono-Regular", "Cascadia Mono", "Liberation Mono", Menlo, monospace;
  --serif: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--ink);
  background:
    linear-gradient(90deg, rgba(25,23,19,.035) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(rgba(25,23,19,.03) 1px, transparent 1px) 0 0 / 24px 24px,
    var(--paper);
  font-family: Avenir Next, "Segoe UI", sans-serif;
}
button, input, select { font: inherit; }
.shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
.topbar {
  padding: 22px 28px 18px;
  border-bottom: 1px solid var(--line);
  background: rgba(244, 240, 231, .92);
  backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 5;
}
.brand { display: flex; align-items: baseline; justify-content: space-between; gap: 18px; }
h1 {
  margin: 0;
  font-family: var(--serif);
  font-size: clamp(30px, 4vw, 54px);
  line-height: .9;
  letter-spacing: 0;
}
.rootline {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 13px;
}
code, pre { font-family: var(--mono); }
.pill {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 5px 9px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 6px;
  color: var(--ink);
}
.layout {
  display: grid;
  grid-template-columns: minmax(210px, 280px) minmax(420px, 1fr) minmax(360px, 45vw);
  gap: 18px;
  padding: 18px;
}
.rail, .list, .detail {
  border: 1px solid var(--line);
  background: rgba(255,250,240,.88);
  box-shadow: var(--shadow);
  min-width: 0;
}
.rail { padding: 12px; }
.list { padding: 14px; }
.detail { padding: 14px; position: sticky; top: 120px; height: calc(100vh - 140px); display: flex; flex-direction: column; }
.section-title {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .14em;
}
.run-button, .protocol-row, .artifact-tab, .action {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 6px;
  cursor: pointer;
}
.run-button {
  width: 100%;
  text-align: left;
  padding: 10px;
  margin-bottom: 8px;
}
.run-button.active, .protocol-row.active, .artifact-tab.active {
  border-color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}
.run-id { display: block; font-family: var(--mono); font-size: 12px; }
.run-meta { display: block; margin-top: 5px; color: var(--muted); font-size: 12px; }
.filters { display: grid; grid-template-columns: 1fr 150px; gap: 10px; margin-bottom: 12px; }
.filters input, .filters select {
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink);
}
.bulk { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.protocol-row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(110px, 1.2fr) 84px repeat(4, minmax(42px, .45fr));
  gap: 8px;
  align-items: center;
  min-height: 48px;
  padding: 8px 10px;
  margin-bottom: 8px;
  text-align: left;
}
.slug { font-family: var(--mono); font-weight: 700; overflow-wrap: anywhere; }
.status {
  display: inline-flex;
  justify-content: center;
  padding: 4px 7px;
  border-radius: 5px;
  font-family: var(--mono);
  font-size: 11px;
  border: 1px solid currentColor;
}
.status.ok { color: var(--green); }
.status.fail { color: var(--red); }
.status.other { color: var(--amber); }
.metric { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.detail h2 { margin: 0; font-family: var(--serif); font-size: 28px; line-height: 1; }
.subpath { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.artifact-tab { padding: 7px 9px; font-size: 12px; color: var(--ink); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
.action {
  min-height: 34px;
  padding: 7px 10px;
  color: var(--ink);
  text-decoration: none;
}
.action.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.action:disabled { color: var(--muted); cursor: not-allowed; opacity: .65; }
.preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #14120f;
  color: #f8f1df;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}
.empty {
  padding: 30px;
  border: 1px dashed var(--line);
  color: var(--muted);
  background: rgba(255,250,240,.6);
}
.toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  padding: 10px 12px;
  background: var(--ink);
  color: var(--paper);
  border-radius: 6px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity .18s ease, transform .18s ease;
  z-index: 10;
}
.toast.show { opacity: 1; transform: translateY(0); }
@media (max-width: 1100px) {
  .layout { grid-template-columns: 220px 1fr; }
  .detail { grid-column: 1 / -1; position: static; height: 560px; }
}
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; padding: 10px; }
  .topbar { padding: 18px 14px; }
  .filters { grid-template-columns: 1fr; }
  .protocol-row { grid-template-columns: 1fr 86px; }
  .protocol-row .metric { display: none; }
  .detail { height: 620px; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand">
      <h1>protocol-info out</h1>
      <span class="pill">${data.totals.runs} runs / ${data.totals.protocols} records</span>
    </div>
    <div class="rootline">
      <span>Generated <code>${data.generatedAt}</code></span>
      <span class="pill"><code>${escapeHtml(data.outputRoot)}</code></span>
      <button class="action" id="copy-root">Copy root</button>
    </div>
  </header>
  <main class="layout">
    <aside class="rail">
      <p class="section-title">Runs</p>
      <div id="runs"></div>
    </aside>
    <section class="list">
      <p class="section-title">Records</p>
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
  runId: DATA.runs[0]?.runId || '',
  slug: DATA.runs[0]?.protocols[0]?.slug || '',
  artifact: 'record.import.json',
  query: '',
  status: 'all'
};

const $ = (id) => document.getElementById(id);

function currentRun() {
  return DATA.runs.find((run) => run.runId === state.runId) || DATA.runs[0] || null;
}

function visibleProtocols() {
  const run = currentRun();
  if (!run) return [];
  const q = state.query.trim().toLowerCase();
  return run.protocols.filter((p) => {
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

function statusClass(status) {
  if (status === 'OK') return 'ok';
  if (String(status).includes('FAIL')) return 'fail';
  return 'other';
}

function renderRuns() {
  const node = $('runs');
  if (DATA.runs.length === 0) {
    node.innerHTML = '<div class="empty">No runs found.</div>';
    return;
  }
  node.innerHTML = DATA.runs.map((run) => {
    const active = run.runId === state.runId ? ' active' : '';
    return '<button class="run-button' + active + '" data-run="' + esc(run.runId) + '">' +
      '<span class="run-id">' + esc(run.runId) + '</span>' +
      '<span class="run-meta">' + run.protocols.length + ' records</span>' +
      '</button>';
  }).join('');
  node.querySelectorAll('[data-run]').forEach((button) => {
    button.addEventListener('click', () => {
      state.runId = button.dataset.run;
      state.slug = currentRun()?.protocols[0]?.slug || '';
      state.artifact = 'record.import.json';
      render();
    });
  });
}

function renderProtocols() {
  const node = $('protocols');
  const protocols = visibleProtocols();
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
  node.innerHTML =
    '<div class="detail-head">' +
      '<div><h2>' + esc(protocol.slug) + '</h2><div class="subpath">' + esc(protocol.relDir || '-') + '</div></div>' +
      '<span class="status ' + statusClass(protocol.row?.status) + '">' + esc(protocol.row?.status || '-') + '</span>' +
    '</div>' +
    '<div class="tabs">' + tabs + '</div>' +
    '<div class="actions">' +
      '<button class="action primary" id="copy-content" ' + (!artifact || artifact.tooLarge ? 'disabled' : '') + '>Copy content</button>' +
      '<button class="action" id="copy-path" ' + (!artifact ? 'disabled' : '') + '>Copy path</button>' +
      (artifact ? '<a class="action" href="' + esc(artifact.href) + '" target="_blank" rel="noreferrer">Open file</a>' : '') +
    '</div>' +
    '<pre class="preview"><code>' + esc(content) + '</code></pre>';
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
}

function render() {
  renderRuns();
  renderProtocols();
  renderDetail();
}

function copyVisibleImports() {
  const artifacts = visibleProtocols()
    .map((p) => p.artifacts.find((a) => a.name === 'record.import.json'))
    .filter((a) => a && !a.tooLarge && a.content)
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
  const run = currentRun();
  copyText(run?.summary?.content || '', 'run summary');
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
