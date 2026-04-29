// Static out/ browser generator.
//
// Writes a self-contained out/index.html so reviewers can inspect and copy
// key artifacts without walking the protocol-first directory tree.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log as gitLog, diff as gitDiff } from './version-store.mjs';
import { parseCdnLogoPath } from './logo-assets.mjs';

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

function parseJsonArtifact(artifacts, name) {
  const artifact = artifacts.find((a) => a.name === name);
  if (!artifact || artifact.tooLarge || !artifact.content) return null;
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

async function localLogoAsset(outputRoot, url) {
  const rel = parseCdnLogoPath(url);
  if (!rel) return { relPath: null, href: null, local: false };
  try {
    await stat(join(outputRoot, rel));
    return { relPath: rel, href: hrefForRelPath(rel), local: true };
  } catch {
    return { relPath: rel, href: hrefForRelPath(rel), local: false };
  }
}

async function logoEntry(outputRoot, { kind, label, field, url }) {
  if (!url) return null;
  const local = await localLogoAsset(outputRoot, url);
  return {
    kind,
    label: label || kind,
    field,
    url,
    relPath: local.relPath,
    href: local.href,
    local: local.local,
  };
}

async function summarizeRecord(outputRoot, record = {}) {
  const logoAssets = [];
  const providerLogo = await logoEntry(outputRoot, {
    kind: 'provider',
    label: record.displayName || record.provider || record.slug || 'provider',
    field: 'providerLogoUrl',
    url: record.providerLogoUrl,
  });
  if (providerLogo) logoAssets.push(providerLogo);

  for (let i = 0; i < (record.members || []).length; i += 1) {
    const member = record.members[i] || {};
    const asset = await logoEntry(outputRoot, {
      kind: 'member',
      label: member.memberName || `member ${i + 1}`,
      field: `members[${i}].avatarUrl`,
      url: member.avatarUrl,
    });
    if (asset) logoAssets.push(asset);
  }

  for (let i = 0; i < (record.audits?.items || []).length; i += 1) {
    const audit = record.audits.items[i] || {};
    const asset = await logoEntry(outputRoot, {
      kind: 'audit',
      label: audit.auditor || `auditor ${i + 1}`,
      field: `audits.items[${i}].auditorLogoUrl`,
      url: audit.auditorLogoUrl,
    });
    if (asset) logoAssets.push(asset);
  }

  return {
    slug: record.slug || '',
    displayName: record.displayName || record.name || record.slug || '',
    provider: record.provider || '',
    type: record.type || '',
    website: record.providerWebsite || '',
    description: record.description || '',
    logoAssets,
    logoCounts: {
      total: logoAssets.length,
      local: logoAssets.filter((a) => a.local).length,
      provider: logoAssets.filter((a) => a.kind === 'provider').length,
      member: logoAssets.filter((a) => a.kind === 'member').length,
      audit: logoAssets.filter((a) => a.kind === 'audit').length,
    },
  };
}

function diffSummary(diffText) {
  const lines = String(diffText || '').split(/\r?\n/);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { files, additions, deletions };
}

function defaultArtifactName(artifacts) {
  const priority = ['record.import.json', 'record.json', 'record.full.json', 'summary.tsv'];
  for (const name of priority) {
    if (artifacts.some((a) => a.name === name)) return name;
  }
  return artifacts[0]?.name || '';
}

function initialsFor(value) {
  const words = String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'PI';
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
}

function buildWorkflowCommands({ slug, history }) {
  const restoreTarget = (history || [])[1]?.sha || '<sha>';
  return [
    { group: 'inspect', label: 'get description', command: `./run.sh get ${slug} description` },
    { group: 'inspect', label: 'history', command: `./run.sh history ${slug}` },
    { group: 'inspect', label: 'diff latest', command: `./run.sh diff ${slug}` },
    { group: 'edit', label: 'set field', command: `./run.sh set ${slug} description '"Updated source-language description"'` },
    { group: 'edit', label: 'analyze field', command: `./run.sh analyze ${slug} fundingRounds --query "verify latest funding rounds"` },
    { group: 'edit', label: 'apply analysis', command: `./run.sh analyze ${slug} fundingRounds --query "verify latest funding rounds" --apply` },
    { group: 'generate', label: 'i18n', command: `./run.sh i18n ${slug} --locales zh_CN,ja_JP` },
    { group: 'generate', label: 'refresh slice', command: `./run.sh refresh ${slug} metadata` },
    { group: 'version', label: 'restore', risk: 'destructive', command: `./run.sh restore ${slug} ${restoreTarget}` },
  ];
}

function statusKind(status) {
  if (status === 'OK') return 'ok';
  if (String(status || '').includes('FAIL')) return 'fail';
  return 'other';
}

function protocolView({ protocol, row, artifacts, recordView, history, defaultDiff }) {
  const logoCounts = recordView.logoCounts || {};
  const metrics = [
    { key: 'members', label: 'Members', value: row.members || '-' },
    { key: 'funding', label: 'Funding', value: row.funding || '-' },
    { key: 'audits', label: 'Audits', value: row.audits || '-' },
    { key: 'logos', label: 'Logos', value: String(logoCounts.total || 0) },
    { key: 'i18n', label: 'i18n', value: row.i18n || '-' },
  ];
  const facts = [
    { label: 'Provider', value: recordView.provider || '-' },
    { label: 'Type', value: recordView.type || '-' },
    { label: 'Members', value: row.members || '-' },
    { label: 'Funding', value: row.funding || '-' },
    { label: 'Audits', value: row.audits || '-' },
    { label: 'Logos', value: `${logoCounts.local || 0}/${logoCounts.total || 0}` },
  ];
  const commands = buildWorkflowCommands({ slug: protocol.slug, history });
  return {
    title: recordView.displayName || protocol.slug,
    initials: initialsFor(recordView.displayName || protocol.slug),
    subtitle: protocol.relDir || '-',
    status: row.status || '-',
    statusKind: statusKind(row.status),
    defaultArtifact: defaultArtifactName(artifacts),
    metrics,
    facts,
    modeCounts: {
      artifact: artifacts.length,
      changes: history.length,
      assets: logoCounts.total || 0,
      commands: commands.length,
    },
    logoSummary: [
      `provider ${logoCounts.provider || 0}`,
      `member ${logoCounts.member || 0}`,
      `audit ${logoCounts.audit || 0}`,
      `local ${logoCounts.local || 0}/${logoCounts.total || 0}`,
    ].join(' · '),
    diffSummary: diffSummary(defaultDiff),
    workflowCommands: commands,
    searchText: [
      protocol.slug,
      row.status,
      row.source,
      row.api_status,
      recordView.displayName,
      recordView.provider,
      recordView.type,
      recordView.description,
    ].join(' ').toLowerCase(),
  };
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
  // Hydrate per-protocol git data (history + default diff) in a single pass.
  // Single loop: avoid re-walking `protocols` twice (one git-log + one git-diff
  // is the goal; two loops would cost two git-logs per protocol).
  for (const p of protocols) {
    p.history = await gitLog(root, { slug: p.slug, limit: 20 }).catch(() => []);
    if (p.history.length >= 2) {
      p.defaultDiff = await gitDiff(root, {
        slug: p.slug,
        fromSha: p.history[1].sha,
        toSha: p.history[0].sha,
      }).catch(() => '');
    } else {
      p.defaultDiff = '';
    }
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
    const record = parseJsonArtifact(artifacts, 'record.json') || {};
    const protocol = {
      slug: p.slug,
      dir: p.dir,
      relDir: relPath(outputRoot, p.dir),
      row: normalizeRow(row, { slug: p.slug, status: metaStatus || 'unknown' }),
      artifacts,
      recordView: await summarizeRecord(outputRoot, record),
      history: p.history || [],
      defaultDiff: p.defaultDiff || '',
    };
    protocol.view = protocolView({
      protocol,
      row: protocol.row,
      artifacts: protocol.artifacts,
      recordView: protocol.recordView,
      history: protocol.history,
      defaultDiff: protocol.defaultDiff,
    });
    hydrated.push(protocol);
  }
  hydrated.sort((a, b) => a.slug.localeCompare(b.slug));

  const okCount = hydrated.filter((p) => p.row?.status === 'OK').length;
  const logoAssetCount = hydrated.reduce((sum, p) => sum + (p.recordView?.logoCounts?.total || 0), 0);
  const statuses = [...new Set(hydrated.map((p) => p.view?.status).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  return {
    generatedAt: new Date().toISOString(),
    outputRoot,
    protocols: hydrated,
    runsLog: idx.runsLog,
    facets: {
      statuses,
    },
    totals: {
      protocols: hydrated.length,
      ok: okCount,
      issues: Math.max(0, hydrated.length - okCount),
      runs: idx.runsLog.length,
      logoAssets: logoAssetCount,
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
  const statusValues = data.facets?.statuses || [];
  const statusOptions = '<option value="all">All statuses</option>' +
    statusValues.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('');
  // Server-rendered per-protocol diff sections. JS hydrates a richer view,
  // but these stay in the static HTML so the diff text is visible in the
  // raw bytes (search/grep/test-friendly) and as a no-JS fallback. Use
  // text-content escaping (only & < >) so JSON quotes survive verbatim.
  const diffSections = data.protocols.map((p) => p.defaultDiff
    ? `<section class="diff" data-slug="${escapeHtml(p.slug)}"><h3>Diff vs previous — ${escapeHtml(p.slug)}</h3><pre>${escapeText(p.defaultDiff)}</pre></section>`
    : ''
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>protocol-info out</title>
<style>
:root {
  --canvas: #eef1f3;
  --surface: #fbfcfb;
  --surface-soft: #edf2f0;
  --surface-warm: #f4f1e8;
  --ink: #202420;
  --muted: #6c746e;
  --faint: #939b96;
  --line: #d7ddd8;
  --line-strong: #b6c0ba;
  --accent: #235f56;
  --accent-soft: #dfece7;
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
    linear-gradient(90deg, rgba(32,36,32,.03) 1px, transparent 1px) 0 0 / 48px 48px,
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
  background: rgba(238, 241, 243, .94);
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
  background: rgba(251,252,251,.78);
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
  background: rgba(251,252,251,.78);
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
  background: rgba(251,252,251,.9);
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
  background: rgba(251,252,251,.95);
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
.protocols-list, .runs-filter-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.runs-filter {
  margin-top: 10px;
  border-top: 1px solid var(--line);
  padding-top: 9px;
}
.runs-filter summary {
  min-height: 30px;
  padding: 5px 2px;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .11em;
}
.runs-filter summary:hover { color: var(--ink); }
.runs-filter-list { margin-top: 5px; }
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
  grid-template-columns: minmax(110px, 1.2fr) 84px repeat(5, minmax(42px, .45fr));
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
  grid-template-columns: minmax(110px, 1.2fr) 84px repeat(5, minmax(42px, .45fr));
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
  align-items: center;
  min-width: 54px;
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
.protocol-row > .metric { text-align: right; }
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--line);
}
.title-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.title-line > div { min-width: 0; }
.record-logo {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-soft);
  object-fit: contain;
}
.record-logo.placeholder {
  display: grid;
  place-items: center;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
}
.detail h2 {
  margin: 0;
  font-family: var(--title);
  font-size: 24px;
  line-height: 1.05;
  letter-spacing: .01em;
  overflow-wrap: anywhere;
}
.subpath { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.record-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
.fact:nth-child(3n + 1) { border-left: 0; }
.fact:nth-child(n + 4) { border-top: 1px solid var(--line); }
.fact span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }
.fact strong { display: block; margin-top: 4px; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.mode-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 9px 0 8px;
}
.mode-button {
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.mode-button:hover { border-color: var(--line-strong); background: var(--surface-soft); }
.mode-button.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.detail-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.artifact-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.scroll-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.changes-pane {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
}
.workflow-panel, .logo-panel {
  padding: 2px 0 10px;
}
.mini-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
}
.mini-title {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .12em;
}
.command-sections {
  display: grid;
  gap: 10px;
}
.command-section {
  display: grid;
  gap: 6px;
}
.command-section-title {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .11em;
}
.command-list {
  display: grid;
  gap: 5px;
}
.command-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(78px, .36fr) minmax(0, 1fr) auto;
  gap: 7px;
  align-items: center;
  min-height: 34px;
  padding: 6px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(251,252,251,.78);
  color: var(--ink);
}
.command-row.danger { border-color: rgba(157,70,62,.32); background: rgba(244,227,223,.42); }
.command-row:hover { border-color: var(--line-strong); background: var(--surface-soft); }
.command-label {
  min-width: 0;
  color: var(--ink);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.command-code {
  min-width: 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.command-copy {
  min-height: 26px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  font-size: 11px;
}
.command-copy:hover { border-color: var(--line-strong); background: var(--surface-soft); }
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 7px;
  max-height: none;
  overflow: auto;
}
.asset-sections {
  display: grid;
  gap: 12px;
}
.asset-section {
  min-width: 0;
}
.asset-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .11em;
}
.asset-card {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(251,252,251,.78);
  padding: 7px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 7px;
  text-decoration: none;
  color: var(--ink);
}
.asset-card:hover { border-color: var(--line-strong); background: var(--surface-soft); }
.asset-thumb {
  width: 34px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface-soft);
  object-fit: contain;
}
.asset-meta { min-width: 0; }
.asset-label {
  display: block;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-kind {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
}
.asset-kind.missing {
  color: var(--red);
  border-color: rgba(157,70,62,.45);
  background: rgba(244,227,223,.52);
}
.asset-path {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
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
.action.primary { background: var(--accent); color: var(--surface); border-color: var(--accent); }
.action:disabled { color: var(--muted); cursor: not-allowed; opacity: .65; }
.history {
  padding: 2px 0 10px;
}
.history h3, .diff h3 {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .12em;
}
.history ul {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  display: grid;
  gap: 6px;
}
.history li {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 8px;
  background: rgba(251,252,251,.78);
  overflow-wrap: anywhere;
}
.diff pre {
  margin: 0;
  max-height: 300px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--code-line);
  border-radius: 7px;
  background: var(--code);
  color: #f2f3e9;
  font-size: 11px;
  line-height: 1.45;
}
.changes-pane .history ul {
  max-height: 150px;
  overflow: auto;
}
.changes-pane .diff {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.changes-pane .diff pre {
  flex: 1;
  max-height: none;
}
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
.preview-top span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: rgba(251,252,251,.62);
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
  .detail {
    grid-column: 1 / -1;
    position: static;
    height: min(760px, calc(100vh - 24px));
    min-height: 560px;
  }
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
    grid-template-columns: repeat(5, minmax(0, 1fr));
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
  .mode-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fact:nth-child(n) { border-left: 1px solid var(--line); border-top: 0; }
  .fact:nth-child(odd) { border-left: 0; }
  .fact:nth-child(n + 3) { border-top: 1px solid var(--line); }
  .command-row { grid-template-columns: 1fr auto; }
  .command-code { grid-column: 1 / -1; grid-row: 2; }
  .command-copy { grid-column: 2; grid-row: 1; }
  .asset-grid { grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); }
  .detail { height: auto; min-height: 620px; }
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
      <div class="stat"><span>Logos</span><strong>${data.totals.logoAssets}</strong></div>
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
        <ul class="runs-filter-list" id="runs-filter-list"></ul>
      </details>
    </aside>
    <section class="list">
      <div class="panel-head"><p class="section-title">Records</p><span class="count" id="record-count"></span></div>
      <div class="filters">
        <input id="query" placeholder="Search slug, provider, status">
        <select id="status">
          ${statusOptions}
        </select>
      </div>
      <div class="bulk">
        <button class="action primary" id="copy-imports">Copy visible imports</button>
        <button class="action" id="copy-summary">Copy run summary</button>
      </div>
      <div class="table-head">
        <span>Slug</span><span>Status</span><span>Members</span><span>Funding</span><span>Audits</span><span>Logos</span><span>i18n</span>
      </div>
      <div id="protocols"></div>
    </section>
    <section class="detail" id="detail"></section>
  </main>
  <noscript class="static-diffs">${diffSections}</noscript>
</div>
<div class="toast" id="toast"></div>
<script id="out-data" type="application/json">${scriptJson(data)}</script>
<script>
const DATA = JSON.parse(document.getElementById('out-data').textContent);
const state = {
  slug: DATA.protocols[0]?.slug || '',
  artifact: DATA.protocols[0]?.view?.defaultArtifact || 'record.import.json',
  mode: 'artifact',
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
    const haystack = p.view?.searchText || [
      p.slug,
      status,
      p.row?.source,
      p.row?.api_status,
    ].join(' ').toLowerCase();
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
    || protocol.artifacts.find((a) => a.name === protocol.view?.defaultArtifact)
    || protocol.artifacts.find((a) => a.name === 'record.import.json')
    || protocol.artifacts[0]
    || null;
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
    const histCount = p.view?.modeCounts?.changes ?? (p.history || []).length;
    return '<li><button class="run-button' + active + '" data-nav-slug="' + esc(p.slug) + '">' +
      '<span class="run-id">' + esc(p.slug) + '</span>' +
      '<span class="run-meta"><span>' + histCount + ' commits</span><span>' + esc(p.view?.status || p.row?.status || '-') + '</span></span>' +
      '</button></li>';
  }).join('');
  node.querySelectorAll('[data-nav-slug]').forEach((button) => {
    button.addEventListener('click', () => {
      state.slug = button.dataset.navSlug;
      const next = DATA.protocols.find((p) => p.slug === state.slug);
      state.artifact = next?.view?.defaultArtifact || 'record.import.json';
      state.mode = 'artifact';
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
  const previousSlug = state.slug;
  state.slug = selected?.slug || state.slug;
  if (selected && previousSlug !== state.slug) {
    state.artifact = selected.view?.defaultArtifact || 'record.import.json';
    state.mode = 'artifact';
  }
  node.innerHTML = protocols.map((p) => {
    const row = p.row || {};
    const active = p.slug === state.slug ? ' active' : '';
    const cls = p.view?.statusKind || statusClass(row.status);
    const metrics = p.view?.metrics || [
      { value: row.members || '-' },
      { value: row.funding || '-' },
      { value: row.audits || '-' },
      { value: p.recordView?.logoCounts?.total ?? 0 },
      { value: row.i18n || '-' },
    ];
    return '<button class="protocol-row' + active + '" data-slug="' + esc(p.slug) + '">' +
      '<span class="slug">' + esc(p.slug) + '</span>' +
      '<span class="status ' + cls + '">' + esc(p.view?.status || row.status || '-') + '</span>' +
      metrics.map((metric) => '<span class="metric">' + esc(metric.value) + '</span>').join('') +
      '</button>';
  }).join('');
  node.querySelectorAll('[data-slug]').forEach((button) => {
    button.addEventListener('click', () => {
      state.slug = button.dataset.slug;
      const next = DATA.protocols.find((p) => p.slug === state.slug);
      state.artifact = next?.view?.defaultArtifact || 'record.import.json';
      state.mode = 'artifact';
      render();
    });
  });
}

function logoSrc(asset) {
  return asset?.local && asset?.href ? asset.href : asset?.url || asset?.href || '';
}

function renderLogoAssets(protocol) {
  const assets = protocol.recordView?.logoAssets || [];
  const counts = protocol.recordView?.logoCounts || {};
  const countText = protocol.view?.logoSummary || [
    'provider ' + (counts.provider || 0),
    'member ' + (counts.member || 0),
    'audit ' + (counts.audit || 0),
    'local ' + (counts.local || 0) + '/' + (counts.total || 0),
  ].join(' · ');
  const groups = [
    ['provider', 'Provider'],
    ['member', 'Members'],
    ['audit', 'Audits'],
  ];
  const renderAsset = (asset) => {
    const href = asset.local && asset.href ? asset.href : asset.url || asset.href || '#';
    const src = logoSrc(asset);
    const path = asset.relPath || asset.url || '';
    const state = asset.local ? 'local' : 'missing local';
    const stateClass = asset.local ? '' : ' missing';
    return '<a class="asset-card" href="' + esc(href) + '" target="_blank" rel="noreferrer" title="' + esc(asset.field || '') + '">' +
      '<img class="asset-thumb" src="' + esc(src) + '" alt="" loading="lazy">' +
      '<span class="asset-meta">' +
        '<span class="asset-label">' + esc(asset.label || asset.kind) + '</span>' +
        '<span class="asset-kind' + stateClass + '">' + esc(asset.kind) + ' · ' + esc(state) + '</span>' +
        '<span class="asset-path">' + esc(path) + '</span>' +
      '</span>' +
    '</a>';
  };
  const body = assets.length === 0
    ? '<div class="empty">No logo assets recorded yet.</div>'
    : '<div class="asset-sections">' + groups.map(([kind, label]) => {
        const groupAssets = assets.filter((asset) => asset.kind === kind);
        if (groupAssets.length === 0) return '';
        const localCount = groupAssets.filter((asset) => asset.local).length;
        return '<section class="asset-section">' +
          '<div class="asset-section-head"><span>' + esc(label) + '</span><span>' + localCount + '/' + groupAssets.length + '</span></div>' +
          '<div class="asset-grid">' + groupAssets.map(renderAsset).join('') + '</div>' +
        '</section>';
      }).join('') + '</div>';
  return '<section class="logo-panel">' +
    '<div class="mini-head"><p class="mini-title">Logo assets</p><span class="count">' + esc(countText) + '</span></div>' +
    body +
  '</section>';
}

function workflowCommands(protocol) {
  if (Array.isArray(protocol.view?.workflowCommands)) {
    return protocol.view.workflowCommands.map((item) => ({
      group: item.group || 'workflow',
      label: item.label,
      command: item.command,
      risk: item.risk || '',
    }));
  }
  const slug = protocol.slug;
  const restoreTarget = (protocol.history || [])[1]?.sha || '<sha>';
  return [
    { group: 'inspect', label: 'get description', command: './run.sh get ' + slug + ' description' },
    { group: 'inspect', label: 'history', command: './run.sh history ' + slug },
    { group: 'inspect', label: 'diff latest', command: './run.sh diff ' + slug },
    { group: 'edit', label: 'set field', command: './run.sh set ' + slug + ' description ' + "'\\"Updated source-language description\\"'" },
    { group: 'edit', label: 'analyze field', command: './run.sh analyze ' + slug + ' fundingRounds --query "verify latest funding rounds"' },
    { group: 'edit', label: 'apply analysis', command: './run.sh analyze ' + slug + ' fundingRounds --query "verify latest funding rounds" --apply' },
    { group: 'generate', label: 'i18n', command: './run.sh i18n ' + slug + ' --locales zh_CN,ja_JP' },
    { group: 'generate', label: 'refresh slice', command: './run.sh refresh ' + slug + ' metadata' },
    { group: 'version', label: 'restore', risk: 'destructive', command: './run.sh restore ' + slug + ' ' + restoreTarget },
  ];
}

function renderWorkflowCommands(protocol) {
  const commands = workflowCommands(protocol);
  const groups = [
    ['inspect', 'Inspect'],
    ['edit', 'Edit'],
    ['generate', 'Generate'],
    ['version', 'Version'],
  ];
  const sections = groups.map(([id, label]) => {
    const items = commands.filter((item) => item.group === id);
    if (items.length === 0) return '';
    return '<section class="command-section">' +
      '<div class="command-section-title">' + esc(label) + '</div>' +
      '<div class="command-list">' + items.map((item) => {
        const danger = item.risk === 'destructive' ? ' danger' : '';
        return '<div class="command-row' + danger + '">' +
          '<span class="command-label">' + esc(item.label) + '</span>' +
          '<code class="command-code" title="' + esc(item.command) + '">' + esc(item.command) + '</code>' +
          '<button class="command-copy" data-copy-command="' + esc(item.command) + '" aria-label="Copy ' + esc(item.label) + ' command">Copy</button>' +
        '</div>';
      }).join('') + '</div>' +
    '</section>';
  }).join('');
  return '<section class="workflow-panel">' +
    '<div class="mini-head"><p class="mini-title">Workflow commands</p><span class="count">copy only</span></div>' +
    '<div class="command-sections">' + sections + '</div>' +
  '</section>';
}

function renderModeTabs(protocol) {
  const counts = protocol.recordView?.logoCounts || {};
  const modeCounts = protocol.view?.modeCounts || {};
  const modes = [
    ['artifact', 'Artifacts', modeCounts.artifact ?? protocol.artifacts.length],
    ['changes', 'Changes', modeCounts.changes ?? (protocol.history || []).length],
    ['assets', 'Assets', modeCounts.assets ?? counts.total ?? 0],
    ['commands', 'Commands', modeCounts.commands ?? workflowCommands(protocol).length],
  ];
  if (!modes.some(([id]) => id === state.mode)) state.mode = 'artifact';
  return '<div class="mode-tabs">' + modes.map(([id, label, count]) => {
    const active = state.mode === id ? ' active' : '';
    return '<button class="mode-button' + active + '" data-detail-mode="' + id + '" aria-pressed="' + (state.mode === id ? 'true' : 'false') + '">' +
      esc(label) + ' <span class="metric">' + esc(count) + '</span></button>';
  }).join('') + '</div>';
}

function renderArtifactPane(protocol, artifact) {
  const tabs = protocol.artifacts.map((a) => {
    const active = a.name === state.artifact ? ' active' : '';
    return '<button class="artifact-tab' + active + '" data-artifact="' + esc(a.name) + '" aria-pressed="' + (a.name === state.artifact ? 'true' : 'false') + '">' +
      esc(a.label) + ' <span class="metric">' + esc(a.sizeLabel) + '</span></button>';
  }).join('');
  const content = artifact
    ? artifact.tooLarge
      ? 'File is too large to embed in this static page. Use Copy path or Open.'
      : artifact.content
    : 'No artifacts found for this record.';
  return '<div class="artifact-pane">' +
    '<div class="tabs">' + tabs + '</div>' +
    '<div class="actions">' +
      '<button class="action primary" id="copy-content" ' + (!artifact || artifact.tooLarge ? 'disabled' : '') + '>Copy content</button>' +
      '<button class="action" id="copy-path" ' + (!artifact ? 'disabled' : '') + '>Copy path</button>' +
      (artifact ? '<a class="action" href="' + esc(artifact.href) + '" target="_blank" rel="noreferrer">Open file</a>' : '') +
    '</div>' +
    '<div class="preview-wrap">' +
      '<div class="preview-top"><span>' + esc(artifact?.name || 'no file') + '</span><span>' + esc(artifact?.sizeLabel || '') + '</span></div>' +
      '<pre class="preview"><code>' + esc(content) + '</code></pre>' +
    '</div>' +
  '</div>';
}

function renderChangesPane(protocol) {
  const history = Array.isArray(protocol.history) ? protocol.history : [];
  const stats = protocol.view?.diffSummary || { files: 0, additions: 0, deletions: 0 };
  const statsHtml = '<div class="diff-stats">' +
    '<span class="diff-stat"><span>files</span><strong>' + esc(stats.files || 0) + '</strong></span>' +
    '<span class="diff-stat"><span>added</span><strong>+' + esc(stats.additions || 0) + '</strong></span>' +
    '<span class="diff-stat"><span>removed</span><strong>-' + esc(stats.deletions || 0) + '</strong></span>' +
  '</div>';
  const historyHtml = history.length === 0
    ? '<section class="history"><h3>History</h3><div class="empty">No version history yet.</div></section>'
    : '<section class="history"><h3>History (' + history.length + ')</h3><ul>' +
        history.map((h) =>
          '<li><code>' + esc(h.sha) + '</code> ' + esc(String(h.ts || '').slice(0, 16)) +
          ' — ' + esc(h.message || '') +
          ' <span class="run-id">' + esc(h.runId || '') + '</span></li>'
        ).join('') +
        '</ul></section>';
  const diffHtml = protocol.defaultDiff
    ? '<section class="diff"><h3>Diff vs previous</h3>' + statsHtml + '<pre>' + esc(protocol.defaultDiff) + '</pre></section>'
    : '<section class="diff"><h3>Diff vs previous</h3><div class="empty">No previous commit to compare.</div></section>';
  return '<div class="scroll-body changes-pane">' + historyHtml + diffHtml + '</div>';
}

function renderDetailBody(protocol, artifact) {
  if (state.mode === 'changes') return renderChangesPane(protocol);
  if (state.mode === 'assets') return '<div class="scroll-body">' + renderLogoAssets(protocol) + '</div>';
  if (state.mode === 'commands') return '<div class="scroll-body">' + renderWorkflowCommands(protocol) + '</div>';
  return renderArtifactPane(protocol, artifact);
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
  const recordView = protocol.recordView || {};
  const providerLogo = (recordView.logoAssets || []).find((a) => a.kind === 'provider');
  const logo = logoSrc(providerLogo);
  const title = protocol.view?.title || recordView.displayName || protocol.slug;
  const facts = protocol.view?.facts || [
    { label: 'Provider', value: recordView.provider || '-' },
    { label: 'Type', value: recordView.type || '-' },
    { label: 'Members', value: protocol.row?.members || '-' },
    { label: 'Funding', value: protocol.row?.funding || '-' },
    { label: 'Audits', value: protocol.row?.audits || '-' },
    { label: 'Logos', value: (recordView.logoCounts?.local || 0) + '/' + (recordView.logoCounts?.total || 0) },
  ];
  const logoHtml = logo
    ? '<img class="record-logo" src="' + esc(logo) + '" alt="">'
    : '<span class="record-logo placeholder">' + esc(protocol.view?.initials || 'PI') + '</span>';
  node.innerHTML =
    '<div class="detail-head">' +
      '<div class="title-line">' + logoHtml + '<div><h2>' + esc(title) + '</h2><div class="subpath">' + esc(protocol.view?.subtitle || protocol.relDir || '-') + '</div></div></div>' +
      '<span class="status ' + (protocol.view?.statusKind || statusClass(protocol.row?.status)) + '">' + esc(protocol.view?.status || protocol.row?.status || '-') + '</span>' +
    '</div>' +
    '<div class="record-facts">' +
      facts.map((fact) => '<div class="fact"><span>' + esc(fact.label) + '</span><strong>' + esc(fact.value) + '</strong></div>').join('') +
    '</div>' +
    renderModeTabs(protocol) +
    '<div class="detail-body">' + renderDetailBody(protocol, artifact) + '</div>';
  node.querySelectorAll('[data-detail-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.mode = button.dataset.detailMode;
      renderDetail();
    });
  });
  node.querySelectorAll('[data-artifact]').forEach((button) => {
    button.addEventListener('click', () => {
      state.mode = 'artifact';
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
  node.querySelectorAll('[data-copy-command]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copyCommand, 'command'));
  });
}

function render() {
  renderProtocolsNav();
  renderRunsFilter();
  renderProtocols();
  renderDetail();
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

// Text-content escape: only the three characters that disambiguate text
// from markup. Preserves quotes verbatim so embedded JSON stays grep-able
// in the rendered HTML (e.g., `"v":1` in a diff stays as `"v":1`).
function escapeText(value) {
  return String(value ?? '').replace(/[&<>]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
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
