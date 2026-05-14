// Live out/ browser and optional static snapshot generator.
//
// The default CLI mode starts a local server that reads the current out/ tree
// on demand. `--static` writes a self-contained out/index.html snapshot for
// debugging/export only.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log as gitLog, diff as gitDiff } from './version-store.mjs';
import { parseCdnLogoPath } from './logo-assets.mjs';
import { SUMMARY_COLUMNS } from './summary-schema.mjs';

const DEFAULT_OUT_ROOT = join(process.cwd(), 'out');
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

const LOGO_FOLDERS = [
  { relPath: 'protocol-logo', label: 'Protocol logos', kind: 'provider' },
  { relPath: 'protocol-member-logo', label: 'Member logos', kind: 'member' },
  { relPath: 'audit-logo', label: 'Audit logos', kind: 'audit' },
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
    jsonMeta: def.kind === 'json' && !text.tooLarge ? parseJsonMeta(text.content) : null,
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

function jsonValueKind(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  if (typeof value === 'object') return `object(${Object.keys(value).length})`;
  return typeof value;
}

function jsonMeta(value) {
  if (Array.isArray(value)) {
    return {
      shape: `array(${value.length})`,
      keys: value.length > 0 && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])
        ? Object.keys(value[0]).slice(0, 8)
        : [],
    };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 10).map(([key, child]) => ({
      key,
      kind: jsonValueKind(child),
    }));
    return {
      shape: `object(${Object.keys(value).length})`,
      keys: entries,
      dataLength: Array.isArray(value.data) ? value.data.length : null,
    };
  }
  return { shape: jsonValueKind(value), keys: [] };
}

function parseJsonMeta(content) {
  try {
    return jsonMeta(JSON.parse(content));
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
    counts: {
      members: Array.isArray(record.members) ? record.members.length : null,
      funding: Array.isArray(record.fundingRounds) ? record.fundingRounds.length : null,
      audits: Array.isArray(record.audits?.items) ? record.audits.items.length : null,
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

function statusKind(status) {
  if (status === 'OK') return 'ok';
  if (String(status || '').includes('FAIL')) return 'fail';
  if (String(status || '').includes('WARN') || String(status || '').includes('STALE')) return 'warn';
  return status ? 'neutral' : 'other';
}

function protocolView({ protocol, row, artifacts, recordView, history, defaultDiff }) {
  const logoCounts = recordView.logoCounts || {};
  const recordCounts = recordView.counts || {};
  const metricValue = (rowValue, recordValue) => {
    if (recordValue != null && recordValue !== '') return String(recordValue);
    if (statusKind(row.status) === 'fail') return '-';
    return rowValue || '-';
  };
  const membersValue = metricValue(row.members, recordCounts.members);
  const fundingValue = metricValue(row.funding, recordCounts.funding);
  const auditsValue = metricValue(row.audits, recordCounts.audits);
  const metrics = [
    { key: 'members', label: 'Members', value: membersValue },
    { key: 'funding', label: 'Funding', value: fundingValue },
    { key: 'audits', label: 'Audits', value: auditsValue },
    { key: 'logos', label: 'Logos', value: String(logoCounts.total || 0) },
    { key: 'i18n', label: 'i18n', value: row.i18n || '-' },
  ];
  const facts = [
    { label: 'Provider', value: recordView.provider || '-' },
    { label: 'Type', value: recordView.type || '-' },
    { label: 'Members', value: membersValue },
    { label: 'Funding', value: fundingValue },
    { label: 'Audits', value: auditsValue },
    { label: 'Logos', value: `${logoCounts.local || 0}/${logoCounts.total || 0}` },
  ];
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
    },
    logoSummary: [
      `provider ${logoCounts.provider || 0}`,
      `member ${logoCounts.member || 0}`,
      `audit ${logoCounts.audit || 0}`,
      `local ${logoCounts.local || 0}/${logoCounts.total || 0}`,
    ].join(' · '),
    diffSummary: diffSummary(defaultDiff),
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
    return { protocols: [] };
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
  return { protocols };
}

// Hydrate the protocols list from `collectOutIndex` with per-protocol
// artifacts, summary row, and meta status, in the protocols-first shape
// consumed by renderHtml.
export async function hydrateView(outputRoot) {
  outputRoot = resolve(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const idx = await collectOutIndex(outputRoot);

  const hydrated = [];
  for (const p of idx.protocols) {
    const artifacts = await collectArtifacts(outputRoot, p.dir);
    const row = await readProtocolRow(p.dir, p.slug);
    const metaStatus = await readMetaStatus(p.dir);
    const record = parseJsonArtifact(artifacts, 'record.json') || {};
    const normalizedRow = normalizeRow(row, { slug: p.slug, status: metaStatus || 'unknown' });
    if (normalizedRow.i18n !== '-' && !artifacts.some((a) => a.name === 'record.full.json')) {
      normalizedRow.i18n = 'STALE';
    }
    const protocol = {
      slug: p.slug,
      dir: p.dir,
      relDir: relPath(outputRoot, p.dir),
      row: normalizedRow,
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
  const view = {
    generatedAt: new Date().toISOString(),
    outputRoot,
    logoFolders: LOGO_FOLDERS.map((folder) => ({
      ...folder,
      path: join(outputRoot, folder.relPath),
      href: hrefForRelPath(folder.relPath),
    })),
    protocols: hydrated,
    totals: {
      protocols: hydrated.length,
      ok: okCount,
      issues: Math.max(0, hydrated.length - okCount),
      logoAssets: logoAssetCount,
    },
  };
  view.revision = createHash('sha256')
    .update(JSON.stringify({
      outputRoot: view.outputRoot,
      protocols: view.protocols,
      totals: view.totals,
    }))
    .digest('hex')
    .slice(0, 16);
  return view;
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

export function renderHtml(data, opts = {}) {
  const issueCount = data.totals.issues;
  const liveDataUrl = opts.liveDataUrl || '';
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
  --canvas: oklch(98.4% 0.024 89);
  --surface: oklch(99.1% 0.008 88);
  --surface-soft: oklch(96.2% 0.024 89);
  --surface-warm: oklch(98% 0.02 88);
  --ink: oklch(15.5% 0.012 31);
  --muted: oklch(43% 0.018 58);
  --faint: oklch(62% 0.015 58);
  --line: var(--ink);
  --line-strong: var(--ink);
  --semantic-selected: oklch(86% 0.17 90);
  --semantic-selected-soft: oklch(94% 0.07 90);
  --semantic-action: oklch(73% 0.16 354);
  --semantic-action-soft: oklch(91% 0.07 354);
  --semantic-info: oklch(78% 0.13 220);
  --semantic-info-soft: oklch(93% 0.045 220);
  --semantic-success: oklch(80% 0.13 134);
  --semantic-success-soft: oklch(93% 0.05 134);
  --semantic-warning: oklch(84% 0.16 76);
  --semantic-warning-soft: oklch(94% 0.06 76);
  --semantic-danger: oklch(73% 0.16 18);
  --semantic-danger-soft: oklch(91% 0.06 18);
  --semantic-neutral: oklch(91% 0.015 78);
  --semantic-location: oklch(80% 0.105 224);
  --semantic-location-soft: oklch(93% 0.04 224);
  --brand-mark: oklch(86% 0.17 90);
  --code: oklch(15.5% 0.012 31);
  --code-line: oklch(15.5% 0.012 31);
  --code-text: oklch(96.5% 0.025 89);
  --canvas-grid: oklch(15.5% 0.012 31 / 3.2%);
  --syntax-json-key: oklch(84% 0.12 90);
  --syntax-json-string: oklch(82% 0.12 134);
  --syntax-json-number: oklch(82% 0.11 220);
  --syntax-json-constant: oklch(80% 0.13 354);
  --diff-file-text: oklch(82% 0.11 220);
  --diff-file-bg: oklch(20% 0.025 220);
  --diff-hunk-text: oklch(84% 0.12 90);
  --diff-hunk-bg: oklch(22% 0.024 90);
  --diff-add-text: oklch(88% 0.09 134);
  --diff-add-bg: oklch(26% 0.06 134);
  --diff-remove-text: oklch(84% 0.09 18);
  --diff-remove-bg: oklch(25% 0.055 18);
  --diff-meta-text: oklch(72% 0.018 70);
  --shadow: var(--ink);
  --shadow-sm: 2px 2px 0 var(--shadow);
  --shadow-md: 4px 4px 0 var(--shadow);
  --shadow-lg: 7px 7px 0 var(--shadow);
  --mono: "Space Mono", "SFMono-Regular", "Cascadia Mono", "Liberation Mono", Menlo, monospace;
  --title: "Space Grotesk", "Avenir Next", "Hiragino Sans", sans-serif;
  --sans: "Space Grotesk", "Avenir Next", "Hiragino Sans", sans-serif;
}
* { box-sizing: border-box; }
html { color-scheme: light; }
body {
  margin: 0;
  min-width: 1360px;
  color: var(--ink);
  background:
    linear-gradient(90deg, var(--canvas-grid) 1px, transparent 1px) 0 0 / 32px 32px,
    linear-gradient(0deg, var(--canvas-grid) 1px, transparent 1px) 0 0 / 32px 32px,
    var(--canvas);
  font-family: var(--sans);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  overflow-x: auto;
}
button, input, select { font: inherit; }
button, a, input, select { outline-color: var(--semantic-info); }
button { font-weight: 700; }
::selection { background: var(--semantic-selected); color: var(--ink); }
.shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  position: relative;
  isolation: isolate;
}
.topbar {
  min-height: 78px;
  padding: 14px 24px;
  border-bottom: 2px solid var(--line);
  background: var(--surface-warm);
  position: sticky;
  top: 0;
  z-index: 5;
  display: grid;
  grid-template-columns: auto minmax(240px, 1fr) auto auto;
  align-items: center;
  gap: 14px;
  box-shadow: 0 3px 0 var(--shadow);
}
.identity {
  min-width: 154px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.product {
  display: inline-block;
  padding: 5px 9px;
  border: 2px solid var(--line);
  background: var(--ink);
  color: var(--brand-mark);
  font-family: var(--title);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: .02em;
  box-shadow: var(--shadow-md);
  transform: rotate(-2deg);
  text-transform: uppercase;
}
.view-name {
  font-family: var(--title);
  font-size: 17px;
  letter-spacing: 0;
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
.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.stat {
  min-height: 30px;
  padding: 5px 9px;
  border: 2px solid var(--line);
  background: var(--surface);
  border-radius: 0;
  box-shadow: var(--shadow-sm);
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
  border: 2px solid var(--line);
  background: var(--surface);
  border-radius: 0;
  box-shadow: var(--shadow-sm);
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
  grid-template-columns: minmax(286px, 328px) minmax(760px, 1fr) minmax(244px, 276px);
  gap: 16px;
  padding: 18px 24px 24px;
  align-items: start;
}
.rail, .list, .detail {
  border: 2px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  min-width: 0;
  border-radius: 0;
}
.rail, .list {
  position: sticky;
  top: 96px;
  height: calc(100vh - 116px);
  overflow: auto;
  padding: 12px;
}
.detail {
  padding: 14px;
  min-height: calc(100vh - 116px);
  display: flex;
  flex-direction: column;
}
.queue-tools {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}
.quick-filters {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.filter-chip {
  min-height: 32px;
  padding: 5px 7px;
  border: 2px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
}
.filter-chip:hover {
  background: var(--surface-soft);
  transform: translateY(-1px);
}
.filter-chip.active {
  background: var(--semantic-selected);
}
.filter-chip .metric {
  color: var(--ink);
}
.rail-section {
  display: grid;
  gap: 8px;
  padding: 0 0 12px;
  margin-bottom: 12px;
  border-bottom: 2px solid var(--line);
}
.rail-section:last-child {
  border-bottom: 0;
  margin-bottom: 0;
  padding-bottom: 0;
}
.rail-label {
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.workspace-actions {
  display: grid;
  gap: 8px;
}
.workspace-actions .action {
  width: 100%;
  display: flex;
  justify-content: center;
}
.folder-grid {
  display: grid;
  gap: 7px;
}
.folder-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px;
  align-items: center;
  padding: 7px 8px;
  border: 2px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.folder-row strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-row code {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.finder-button {
  min-height: 27px;
  padding: 3px 8px;
  border: 2px solid var(--line);
  background: var(--semantic-location);
  color: var(--ink);
  box-shadow: 1px 1px 0 var(--shadow);
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}
.finder-button:hover {
  background: var(--semantic-selected);
  transform: translateY(-1px);
}
.asset-card {
  position: relative;
}
.asset-card.has-reveal {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}
.asset-link {
  min-width: 0;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 7px;
  color: inherit;
  text-decoration: none;
}
.asset-reveal {
  justify-self: end;
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
  border-bottom: 2px solid var(--line);
  background: var(--surface-warm);
}
.panel-meta {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.section-title {
  margin: 0;
  color: var(--ink);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.count {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.live-state {
  min-height: 19px;
  padding: 2px 5px;
  border: 2px solid var(--line);
  background: var(--semantic-success-soft);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  box-shadow: 1px 1px 0 var(--shadow);
}
.live-state.checking { background: var(--semantic-location-soft); }
.live-state.changed { background: var(--semantic-selected); }
.live-state.error { background: var(--semantic-danger-soft); }
.live-state.static { background: var(--semantic-neutral); color: var(--muted); }
.protocol-row, .artifact-tab, .action {
  border: 2px solid transparent;
  background: transparent;
  border-radius: 0;
  cursor: pointer;
  transition: background .12s ease, box-shadow .12s ease, transform .12s ease, color .12s ease;
}
.protocol-row:hover, .artifact-tab:hover, .action:hover {
  border-color: var(--line);
  background: var(--surface-soft);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}
.protocol-row:active, .artifact-tab:active, .action:active {
  background: var(--semantic-selected-soft);
  box-shadow: 1px 1px 0 var(--shadow);
  transform: translate(1px, 1px);
}
.protocol-row:focus-visible,
.artifact-tab:focus-visible,
.mode-button:focus-visible,
.filter-chip:focus-visible,
.action:focus-visible,
.finder-button:focus-visible,
input:focus-visible {
  outline: 3px solid var(--semantic-info);
  outline-offset: 2px;
}
.protocol-row.active, .artifact-tab.active {
  border-color: var(--line);
  background: var(--semantic-selected);
  box-shadow: var(--shadow-sm);
}
.filters { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 0; }
.filters input, .filters select {
  min-height: 36px;
  padding: 8px 10px;
  border: 2px solid var(--line);
  border-radius: 0;
  background: var(--surface);
  color: var(--ink);
  box-shadow: var(--shadow-sm);
  font-weight: 700;
}
.filters input:focus, .filters select:focus {
  border-color: var(--line);
  box-shadow: 4px 4px 0 var(--semantic-info);
}
.bulk { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 0; }
.workspace-actions.bulk { display: grid; }
.table-head {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) auto;
  gap: 8px;
  padding: 2px 10px 7px;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .09em;
}
.table-head .desktop-metric-heads {
  display: none;
}
.protocol-row {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas:
    "title status"
    "metrics metrics";
  gap: 8px 10px;
  align-items: start;
  min-height: 72px;
  padding: 11px 12px;
  margin-bottom: 8px;
  text-align: left;
}
.queue-title {
  grid-area: title;
  min-width: 0;
  display: grid;
  gap: 3px;
}
.slug { font-family: var(--mono); font-weight: 700; overflow-wrap: anywhere; }
.queue-sub {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-width: 54px;
  padding: 3px 7px;
  border-radius: 0;
  font-family: var(--mono);
  font-size: 10px;
  border: 2px solid var(--line);
  color: var(--ink);
  font-weight: 700;
}
.protocol-row > .status { grid-area: status; }
.status.ok { background: var(--semantic-success); }
.status.fail { background: var(--semantic-danger); }
.status.warn { background: var(--semantic-warning); }
.status.neutral, .status.other { background: var(--semantic-neutral); }
.metric { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.queue-metrics {
  grid-area: metrics;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.metric-box {
  min-width: 0;
  padding: 5px 6px;
  border: 2px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  box-shadow: 1px 1px 0 var(--shadow);
}
.metric-box span {
  display: block;
  color: var(--muted);
  font-family: var(--sans);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric-box strong {
  display: block;
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
  padding-bottom: 9px;
  border-bottom: 2px solid var(--line);
}
.detail-actions {
  flex: 0 0 auto;
  display: grid;
  justify-items: end;
  gap: 7px;
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
  border: 2px solid var(--line);
  border-radius: 0;
  background: var(--semantic-info-soft);
  box-shadow: var(--shadow-sm);
  object-fit: contain;
  image-rendering: auto;
}
.record-logo.placeholder {
  display: grid;
  place-items: center;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
}
.detail h2 {
  margin: 0;
  font-family: var(--title);
  font-size: 26px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
.subpath { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.record-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  margin: 8px 0;
  border-top: 2px solid var(--line);
  border-bottom: 2px solid var(--line);
}
.fact {
  border: 0;
  border-left: 2px solid var(--line);
  background: transparent;
  padding: 8px 9px;
  min-width: 0;
}
.fact:first-child { border-left: 0; }
.fact:nth-child(3n + 1) { border-left: 0; }
.fact:nth-child(n + 4) { border-top: 2px solid var(--line); }
.fact span { display: block; color: var(--muted); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.fact strong { display: block; margin-top: 4px; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.mode-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
  margin: 9px 0 8px;
}
.mode-button {
  min-height: 34px;
  padding: 6px 8px;
  border: 2px solid var(--line);
  border-radius: 0;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.mode-button:hover { border-color: var(--line-strong); background: var(--surface-soft); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
.mode-button.active {
  border-color: var(--line);
  color: var(--ink);
  background: var(--semantic-selected);
  box-shadow: var(--shadow-sm);
}
.detail-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.artifact-pane {
  flex: 1;
  min-height: 760px;
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
.logo-panel {
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
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
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
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.asset-card {
  min-width: 0;
  border: 2px solid var(--line);
  border-radius: 0;
  background: var(--surface);
  padding: 7px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 7px;
  color: var(--ink);
  box-shadow: var(--shadow-sm);
}
.asset-card:hover { border-color: var(--line-strong); background: var(--surface-soft); transform: translateY(-1px); }
.asset-thumb {
  width: 34px;
  height: 34px;
  border: 2px solid var(--line);
  border-radius: 0;
  background: var(--semantic-info-soft);
  object-fit: contain;
}
.asset-thumb.placeholder {
  display: grid;
  place-items: center;
  background: var(--semantic-danger-soft);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}
.asset-meta { min-width: 0; }
.asset-label {
  display: block;
  font-size: 12px;
  font-weight: 700;
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
  border-radius: 0;
  border: 2px solid var(--line);
  color: var(--ink);
  background: var(--semantic-success);
  font-family: var(--mono);
  font-size: 10px;
}
.asset-kind.missing {
  color: var(--ink);
  background: var(--semantic-danger);
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
.i18n-pane {
  flex: 0 0 auto;
  overflow: visible;
  display: grid;
  gap: 12px;
  align-content: start;
  padding: 2px 0 18px;
}
.i18n-summary {
  border: 2px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  padding: 12px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
}
.i18n-summary h3 {
  margin: 3px 0 0;
  font-size: 18px;
  line-height: 1.1;
}
.i18n-summary p {
  margin: 6px 0 0;
  color: var(--muted);
  line-height: 1.45;
}
.i18n-stats {
  min-width: 230px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 2px solid var(--line);
  background: var(--surface-soft);
}
.i18n-stats span {
  min-width: 0;
  padding: 7px 8px;
  border-left: 2px solid var(--line);
  border-top: 2px solid var(--line);
}
.i18n-stats span:nth-child(odd) { border-left: 0; }
.i18n-stats span:nth-child(-n + 2) { border-top: 0; }
.i18n-stats em {
  display: block;
  color: var(--muted);
  font-style: normal;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.i18n-stats strong {
  display: block;
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.locale-switcher {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.locale-button {
  min-height: 31px;
  padding: 5px 8px;
  border: 2px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}
.locale-button:hover {
  background: var(--surface-soft);
  transform: translateY(-1px);
}
.locale-button.active {
  background: var(--semantic-selected);
}
.locale-button.failed {
  background: var(--semantic-danger-soft);
}
.locale-button.source {
  background: var(--semantic-location-soft);
}
.locale-button:focus-visible {
  outline: 3px solid var(--semantic-info);
  outline-offset: 2px;
}
.i18n-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 10px;
  flex-wrap: wrap;
}
.i18n-current {
  min-width: 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.45;
}
.i18n-compare {
  display: grid;
  gap: 8px;
}
.i18n-row {
  display: grid;
  grid-template-columns: minmax(150px, .55fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 0;
  border: 2px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.i18n-cell {
  min-width: 0;
  padding: 8px 10px;
  border-left: 2px solid var(--line);
  line-height: 1.48;
  overflow-wrap: anywhere;
}
.i18n-cell:first-child {
  border-left: 0;
  background: var(--surface-warm);
}
.i18n-cell em {
  display: block;
  color: var(--muted);
  font-style: normal;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
.i18n-cell strong {
  display: block;
  margin-top: 3px;
}
.i18n-cell.missing {
  color: var(--muted);
  background: var(--semantic-warning-soft);
}
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 7px; }
.artifact-tab {
  padding: 6px 9px;
  border-color: var(--line);
  background: var(--surface);
  font-size: 12px;
  color: var(--ink);
  box-shadow: var(--shadow-sm);
}
.reader-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
  margin: 0 0 9px;
}
.actions { display: flex; gap: 7px; flex-wrap: wrap; margin: 0; justify-content: flex-end; }
.action {
  min-height: 32px;
  padding: 6px 10px;
  border-color: var(--line);
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
  box-shadow: var(--shadow-sm);
}
.action.primary { background: var(--semantic-action); color: var(--ink); border-color: var(--line); }
.action[data-reveal-rel],
.top-actions .action[data-reveal-rel] {
  background: var(--semantic-location);
}
.action[data-reveal-rel]:hover,
.top-actions .action[data-reveal-rel]:hover {
  background: var(--semantic-selected);
}
.action.primary:hover {
  background: var(--semantic-action-soft);
}
.action:disabled { color: var(--muted); cursor: not-allowed; opacity: .65; }
.json-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
}
.json-chip {
  max-width: 100%;
  min-height: 24px;
  padding: 3px 7px;
  border: 2px solid var(--line);
  border-radius: 0;
  background: var(--semantic-info-soft);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.json-reader-note {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  line-height: 1.4;
  margin-top: 4px;
}
.json-reader-note strong {
  color: var(--ink);
}
.history {
  padding: 2px 0 10px;
}
.history h3, .diff h3 {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.history ul {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  display: grid;
  gap: 6px;
}
.history li {
  border: 2px solid var(--line);
  border-radius: 0;
  padding: 7px 8px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow-wrap: anywhere;
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
.changes-pane .diff-code {
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
  border: 2px solid var(--line);
  background: var(--semantic-neutral);
  padding: 6px 8px;
  border-radius: 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11px;
}
.preview-wrap {
  flex: 1;
  min-height: 680px;
  display: grid;
  grid-template-rows: auto auto;
  border: 2px solid var(--code-line);
  border-radius: 0;
  overflow: hidden;
  background: var(--code);
  box-shadow: var(--shadow-md);
}
.preview-top {
  min-height: 32px;
  padding: 7px 11px;
  color: var(--ink);
  background: var(--semantic-selected);
  border-bottom: 2px solid var(--code-line);
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
  min-height: 640px;
  overflow-x: auto;
  overflow-y: visible;
  margin: 0;
  padding: 18px 20px 32px;
  background: var(--code);
  color: var(--code-text);
  font-size: 12px;
  line-height: 1.62;
  white-space: pre;
}
.preview code { tab-size: 2; }
.json-key { color: var(--syntax-json-key); }
.json-string { color: var(--syntax-json-string); }
.json-number { color: var(--syntax-json-number); }
.json-bool, .json-null { color: var(--syntax-json-constant); }
.diff-tools {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.diff-code {
  margin: 0;
  max-height: 300px;
  overflow: auto;
  border: 2px solid var(--code-line);
  border-radius: 0;
  background: var(--code);
  color: var(--code-text);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.45;
}
.diff-line {
  display: block;
  min-width: max-content;
  padding: 0 10px;
  white-space: pre;
}
.diff-line.file { color: var(--diff-file-text); background: var(--diff-file-bg); }
.diff-line.hunk { color: var(--diff-hunk-text); background: var(--diff-hunk-bg); }
.diff-line.add { color: var(--diff-add-text); background: var(--diff-add-bg); }
.diff-line.del { color: var(--diff-remove-text); background: var(--diff-remove-bg); }
.diff-line.meta { color: var(--diff-meta-text); }
.protocol-preview {
  display: grid;
  align-content: start;
  gap: 14px;
  padding: 2px 0 18px;
  flex: 0 0 auto;
  overflow: visible;
}
.preview-hero {
  border: 2px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) minmax(184px, auto);
  gap: 14px;
  align-items: start;
  padding: 14px;
}
.preview-logo {
  width: 76px;
  height: 76px;
  border: 2px solid var(--line);
  background: var(--semantic-info-soft);
  object-fit: contain;
  box-shadow: var(--shadow-sm);
}
.preview-logo.placeholder {
  display: grid;
  place-items: center;
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 700;
}
.preview-title {
  min-width: 0;
  display: grid;
  gap: 8px;
}
.preview-title h3 {
  margin: 0;
  font-family: var(--title);
  font-size: 30px;
  line-height: 1;
}
.preview-title p {
  margin: 0;
  max-width: 72ch;
  color: var(--ink);
  line-height: 1.55;
}
.preview-tags,
.preview-links,
.preview-section-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.preview-chip,
.preview-link {
  min-height: 26px;
  padding: 4px 7px;
  border: 2px solid var(--line);
  background: var(--semantic-neutral);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  text-decoration: none;
}
.preview-link {
  background: var(--semantic-location);
}
.preview-link:hover {
  background: var(--semantic-selected);
  transform: translateY(-1px);
}
.preview-health {
  min-width: 180px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 2px solid var(--line);
  background: var(--surface-soft);
}
.preview-health span {
  min-width: 0;
  padding: 8px;
  border-left: 2px solid var(--line);
  border-top: 2px solid var(--line);
}
.preview-health span:nth-child(odd) { border-left: 0; }
.preview-health span:nth-child(-n + 2) { border-top: 0; }
.preview-health em {
  display: block;
  color: var(--muted);
  font-style: normal;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.preview-health strong {
  display: block;
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 13px;
}
.preview-section {
  border: 2px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  padding: 12px;
  align-self: start;
}
.preview-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.preview-section-head h3 {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.preview-section-head span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.preview-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 8px;
}
.person-card,
.funding-row,
.audit-row {
  min-width: 0;
  border: 2px solid var(--line);
  background: var(--surface-warm);
  padding: 9px;
}
.person-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
}
.person-avatar {
  width: 42px;
  height: 42px;
  border: 2px solid var(--line);
  background: var(--semantic-info-soft);
  object-fit: contain;
}
.person-avatar.placeholder {
  display: grid;
  place-items: center;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}
.person-card strong,
.funding-row strong,
.audit-row strong {
  display: block;
  overflow-wrap: anywhere;
}
.person-card p,
.funding-row p,
.audit-row p {
  margin: 4px 0 0;
  color: var(--muted);
  line-height: 1.45;
}
.preview-list {
  display: grid;
  gap: 8px;
}
.funding-row,
.audit-row {
  display: grid;
  grid-template-columns: minmax(120px, .9fr) minmax(0, 2fr) minmax(72px, auto);
  gap: 10px;
  align-items: start;
}
.row-kicker {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  text-transform: uppercase;
}
.static-diffs .diff pre {
  margin: 0;
  max-height: 300px;
  overflow: auto;
  padding: 10px;
  border: 2px solid var(--code-line);
  border-radius: 0;
  background: var(--code);
  color: var(--code-text);
  font-size: 11px;
  line-height: 1.45;
}
.empty {
  padding: 18px;
  border: 2px dashed var(--line);
  color: var(--muted);
  background: var(--surface-warm);
  border-radius: 0;
}
.toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  padding: 10px 12px;
  background: var(--ink);
  color: var(--semantic-location);
  border: 2px solid var(--line);
  border-radius: 0;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity .18s ease, transform .18s ease;
  z-index: 10;
  box-shadow: var(--shadow-md);
}
.toast.show { opacity: 1; transform: translateY(0); }
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
      <span class="generated">Generated <code id="generated-at">${data.generatedAt}</code></span>
      <span class="pill"><code id="root-path">${escapeHtml(data.outputRoot)}</code></span>
    </div>
    <div class="statbar">
      <div class="stat"><span>Records</span><strong id="stat-records">${data.totals.protocols}</strong></div>
      <div class="stat"><span>Issues</span><strong id="stat-issues">${issueCount}</strong></div>
      <div class="stat"><span>Logos</span><strong id="stat-logos">${data.totals.logoAssets}</strong></div>
    </div>
    <div class="top-actions">
      <button class="action" data-reveal-rel="." data-copy-fallback="${escapeHtml(data.outputRoot)}">Open out</button>
      <button class="action" id="copy-root">Copy root</button>
    </div>
  </header>
  <main class="layout">
    <section class="list">
      <div class="panel-head"><p class="section-title">Review queue</p><span class="panel-meta"><span class="live-state static" id="live-state">static</span><span class="count" id="record-count"></span></span></div>
      <div class="queue-tools">
        <div class="filters">
          <input id="query" placeholder="Search slug, provider, status">
        </div>
        <div class="quick-filters" id="quick-filters">
          <button class="filter-chip active" data-queue-filter="all">All <span class="metric" id="filter-count-all">0</span></button>
          <button class="filter-chip" data-queue-filter="issues">Review <span class="metric" id="filter-count-issues">0</span></button>
          <button class="filter-chip" data-queue-filter="assets">Assets <span class="metric" id="filter-count-assets">0</span></button>
          <button class="filter-chip" data-queue-filter="ok">OK <span class="metric" id="filter-count-ok">0</span></button>
        </div>
      </div>
      <div class="table-head">
        <span>Protocol</span><span>Status</span><span class="desktop-metric-heads">Members</span><span class="desktop-metric-heads">Funding</span><span class="desktop-metric-heads">Audits</span><span class="desktop-metric-heads">Logos</span><span class="desktop-metric-heads">i18n</span>
      </div>
      <div id="protocols"></div>
    </section>
    <section class="detail" id="detail"></section>
    <aside class="rail">
      <div class="panel-head"><p class="section-title">Workspace</p><span class="count" id="protocol-count">${data.totals.protocols}</span></div>
      <section class="rail-section">
        <div class="rail-label">Bulk actions</div>
        <div class="workspace-actions bulk">
          <button class="action primary" id="copy-imports">Copy visible imports</button>
          <button class="action" id="copy-summary">Copy visible summary</button>
        </div>
      </section>
      <section class="rail-section">
        <div class="rail-label">Logo folders</div>
        <div id="workspace-logo-folders"></div>
      </section>
    </aside>
  </main>
  <noscript class="static-diffs">${diffSections}</noscript>
</div>
<div class="toast" id="toast"></div>
<script id="out-data" type="application/json">${scriptJson(data)}</script>
<script>
let DATA = JSON.parse(document.getElementById('out-data').textContent);
const LIVE_DATA_URL = ${JSON.stringify(liveDataUrl)};
const LIVE_REFRESH_MS = 750;
const SUMMARY_COLUMNS = ${JSON.stringify(SUMMARY_COLUMNS)};
const state = {
  slug: DATA.protocols[0]?.slug || '',
  artifact: DATA.protocols[0]?.view?.defaultArtifact || 'record.import.json',
  mode: 'artifact',
  locale: 'source',
  query: '',
  queueFilter: 'all',
  liveStatus: LIVE_DATA_URL ? 'live' : 'static',
  lastCheckedAt: '',
  lastUpdatedAt: '',
  refreshInFlight: false,
};

const $ = (id) => document.getElementById(id);

function renderChrome() {
  const totals = DATA.totals || {};
  const setText = (id, value) => {
    const node = $(id);
    if (node) node.textContent = String(value ?? '');
  };
  setText('generated-at', DATA.generatedAt || '');
  setText('root-path', DATA.outputRoot || '');
  setText('stat-records', totals.protocols || 0);
  setText('stat-logos', totals.logoAssets || 0);
  setText('stat-issues', totals.issues || 0);
  setText('protocol-count', totals.protocols || 0);
  renderWorkbenchState();
  renderLiveState();
}

function renderWorkbenchState() {
  const counts = queueCounts(baseProtocols());
  Object.entries(counts).forEach(([key, value]) => {
    const node = $('filter-count-' + key);
    if (node) node.textContent = String(value);
  });
  document.querySelectorAll('[data-queue-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.queueFilter === state.queueFilter);
  });
}

function formatClock(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function renderLiveState() {
  const node = $('live-state');
  if (!node) return;
  const status = state.liveStatus || (LIVE_DATA_URL ? 'live' : 'static');
  node.className = 'live-state ' + status;
  if (!LIVE_DATA_URL) {
    node.textContent = 'static';
  } else if (status === 'checking') {
    node.textContent = 'checking';
  } else if (status === 'changed') {
    node.textContent = 'updated ' + formatClock(state.lastUpdatedAt || state.lastCheckedAt);
  } else if (status === 'error') {
    node.textContent = 'retrying';
  } else {
    node.textContent = 'live ' + formatClock(state.lastCheckedAt || state.lastUpdatedAt);
  }
}

function baseProtocols() {
  const q = state.query.trim().toLowerCase();
  return DATA.protocols.filter((p) => {
    const status = p.row?.status || '';
    const haystack = p.view?.searchText || [
      p.slug,
      status,
      p.row?.source,
      p.row?.api_status,
    ].join(' ').toLowerCase();
    return !q || haystack.includes(q);
  });
}

function visibleProtocols() {
  let pool = baseProtocols();
  if (state.queueFilter === 'issues') pool = pool.filter(isIssueProtocol);
  else if (state.queueFilter === 'ok') pool = pool.filter((p) => statusValue(p) === 'OK');
  else if (state.queueFilter === 'assets') pool = pool.filter((p) => missingAssetCount(p) > 0);
  return sortProtocols(pool);
}

function statusValue(protocol) {
  return protocol?.view?.status || protocol?.row?.status || '';
}

function isIssueProtocol(protocol) {
  return statusValue(protocol) !== 'OK';
}

function missingAssetCount(protocol) {
  const counts = protocol?.recordView?.logoCounts || {};
  return Math.max(0, (counts.total || 0) - (counts.local || 0));
}

function queueCounts(protocols) {
  return {
    all: protocols.length,
    issues: protocols.filter(isIssueProtocol).length,
    assets: protocols.filter((p) => missingAssetCount(p) > 0).length,
    ok: protocols.filter((p) => statusValue(p) === 'OK').length,
  };
}

function issueRank(protocol) {
  const status = statusValue(protocol);
  if (String(status).includes('FAIL')) return 0;
  if (status !== 'OK') return 1;
  return 2;
}

function sortProtocols(protocols) {
  return protocols.slice().sort((a, b) => {
    return issueRank(a) - issueRank(b) || a.slug.localeCompare(b.slug);
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
  if (String(status).includes('WARN') || String(status).includes('STALE')) return 'warn';
  return status ? 'neutral' : 'other';
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
    state.locale = 'source';
  }
  node.innerHTML = protocols.map((p) => {
    const row = p.row || {};
    const active = p.slug === state.slug ? ' active' : '';
    const cls = p.view?.statusKind || statusClass(row.status);
    const metrics = p.view?.metrics || [
      { label: 'Members', value: row.members || '-' },
      { label: 'Funding', value: row.funding || '-' },
      { label: 'Audits', value: row.audits || '-' },
      { label: 'Logos', value: p.recordView?.logoCounts?.total ?? 0 },
      { label: 'i18n', value: row.i18n || '-' },
    ];
    const subtitle = [
      p.view?.title && p.view.title !== p.slug ? p.view.title : '',
      p.recordView?.provider || '',
      p.recordView?.type || '',
    ].filter(Boolean).slice(0, 2).join(' · ');
    const queueMetricLabel = (metric) => ({
      members: 'MEM',
      funding: 'FUND',
      audits: 'AUD',
      logos: 'LOGO',
      i18n: 'I18N',
    }[metric.key] || metric.label || metric.key || '');
    return '<button class="protocol-row' + active + '" data-slug="' + esc(p.slug) + '">' +
      '<span class="queue-title"><span class="slug">' + esc(p.slug) + '</span>' +
        '<span class="queue-sub">' + esc(subtitle || p.relDir || '-') + '</span></span>' +
      '<span class="status ' + cls + '">' + esc(p.view?.status || row.status || '-') + '</span>' +
      '<span class="queue-metrics">' + metrics.map((metric) =>
        '<span class="metric-box"><span>' + esc(queueMetricLabel(metric)) + '</span><strong>' + esc(metric.value) + '</strong></span>'
      ).join('') + '</span>' +
      '</button>';
  }).join('');
  node.querySelectorAll('[data-slug]').forEach((button) => {
    button.addEventListener('click', () => {
      state.slug = button.dataset.slug;
      const next = DATA.protocols.find((p) => p.slug === state.slug);
      state.artifact = next?.view?.defaultArtifact || 'record.import.json';
      state.mode = 'artifact';
      state.locale = 'source';
      render();
    });
  });
}

function logoSrc(asset) {
  return asset?.local && asset?.href ? asset.href : asset?.url || asset?.href || '';
}

function assetInitials(asset) {
  return String(asset?.label || asset?.kind || 'LG')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'LG';
}

function artifactByName(protocol, name) {
  return protocol?.artifacts?.find((a) => a.name === name) || null;
}

function recordArtifact(protocol) {
  return artifactByName(protocol, 'record.json');
}

function parseArtifactJson(artifact) {
  if (!artifact || artifact.tooLarge || !artifact.content) return null;
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

function parseProtocolArtifact(protocol, name) {
  return parseArtifactJson(artifactByName(protocol, name));
}

function recordForPreview(protocol) {
  return parseArtifactJson(recordArtifact(protocol)) || {};
}

function mergeTranslatedRecord(base, translated) {
  const out = JSON.parse(JSON.stringify(base || {}));
  if (!translated || typeof translated !== 'object') return out;
  for (const [key, value] of Object.entries(translated)) {
    if (Array.isArray(value) && Array.isArray(out[key])) {
      value.forEach((item, index) => {
        if (out[key][index] && item && typeof item === 'object' && !Array.isArray(item)) {
          out[key][index] = { ...out[key][index], ...item };
        }
      });
    } else {
      out[key] = value;
    }
  }
  return out;
}

function i18nCodeLabel(code) {
  if (code === 'source') return 'Source';
  return String(code || '').replace(/_/g, '-');
}

function dashboardLocale(code) {
  if (code === 'source') return 'en';
  return String(code || '').replace(/_/g, '-').toLowerCase();
}

function i18nInfo(protocol) {
  const source = recordForPreview(protocol);
  const full = parseProtocolArtifact(protocol, 'record.full.json') || {};
  const meta = parseProtocolArtifact(protocol, 'meta.json')?.i18n || {};
  const translations = full.i18n && typeof full.i18n === 'object' && !Array.isArray(full.i18n)
    ? full.i18n
    : {};
  const okCodes = Array.isArray(meta.locales_ok) ? meta.locales_ok : Object.keys(translations);
  const failedCodes = Array.isArray(meta.locales_failed) ? meta.locales_failed : [];
  const requestedCodes = Array.isArray(meta.locales_requested) ? meta.locales_requested : [];
  const codes = Array.from(new Set([
    ...Object.keys(translations),
    ...okCodes,
    ...failedCodes,
    ...requestedCodes,
  ])).filter(Boolean).sort();
  const locales = [{
    id: 'source',
    code: 'source',
    label: 'Source',
    dashboardLocale: 'en',
    status: 'source',
    translation: null,
  }].concat(codes.map((code) => {
    const failed = failedCodes.includes(code);
    const ok = okCodes.includes(code) || Object.hasOwn(translations, code);
    return {
      id: code,
      code,
      label: i18nCodeLabel(code),
      dashboardLocale: dashboardLocale(code),
      status: failed ? 'failed' : (ok ? 'ok' : 'requested'),
      translation: translations[code] || null,
    };
  }));
  return {
    source,
    full,
    meta,
    translations,
    locales,
    okCodes,
    failedCodes,
    requestedCodes,
    fullArtifact: artifactByName(protocol, 'record.full.json'),
  };
}

function selectedI18n(protocol) {
  const info = i18nInfo(protocol);
  if (!info.locales.some((locale) => locale.id === state.locale)) state.locale = info.locales[0]?.id || 'source';
  const selected = info.locales.find((locale) => locale.id === state.locale) || info.locales[0];
  const record = selected?.id === 'source'
    ? info.source
    : mergeTranslatedRecord(info.source, selected?.translation || {});
  return { ...info, selected, record };
}

function i18nLocaleCount(protocol) {
  return Math.max(0, selectedI18n(protocol).locales.length - 1);
}

function i18nCompareRows(source, localized) {
  const rows = [];
  const push = (label, sourceValue, localizedValue) => {
    rows.push({
      label,
      source: valueOrDash(sourceValue),
      localized: localizedValue == null || localizedValue === '' ? '-' : String(localizedValue),
      missing: localizedValue == null || localizedValue === '',
    });
  };
  push('description', source.description, localized.description);
  const sourceMembers = Array.isArray(source.members) ? source.members : [];
  const localizedMembers = Array.isArray(localized.members) ? localized.members : [];
  const memberCount = Math.max(sourceMembers.length, localizedMembers.length);
  for (let index = 0; index < memberCount; index += 1) {
    const sourceMember = sourceMembers[index] || {};
    const localizedMember = localizedMembers[index] || {};
    const memberName = sourceMember.memberName || localizedMember.memberName || 'member ' + (index + 1);
    push(memberName + ' position', sourceMember.memberPosition, localizedMember.memberPosition);
    push(memberName + ' one-liner', sourceMember.oneLiner, localizedMember.oneLiner);
  }
  return rows;
}

function valueOrDash(value) {
  if (value == null || value === '') return '-';
  return String(value);
}

function listCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function renderPreviewLink(label, url) {
  if (!url) return '';
  return '<a class="preview-link" href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(label) + '</a>';
}

function previewLocalLogo(protocol, url, kind) {
  const assets = protocol?.recordView?.logoAssets || [];
  if (!url) return null;
  return assets.find((asset) => asset.kind === kind && asset.url === url && asset.local) || null;
}

function compactText(value, fallback = '-') {
  const text = valueOrDash(value);
  return text.length > 180 ? text.slice(0, 177) + '...' : text || fallback;
}

function renderFolderButtons(folders, opts = {}) {
  const items = Array.isArray(folders) ? folders : [];
  if (items.length === 0) return '<div class="empty">No folders available.</div>';
  return '<div class="folder-grid">' + items.map((folder) =>
    '<div class="folder-row">' +
      '<span><strong>' + esc(folder.label || folder.relPath) + '</strong><code>' + esc(folder.relPath || folder.path || '') + '</code></span>' +
      '<button type="button" class="finder-button" data-reveal-rel="' + esc(folder.relPath || '') + '" data-copy-fallback="' + esc(folder.path || '') + '" aria-label="Reveal ' + esc(folder.label || folder.relPath || 'folder') + ' in Finder">' +
        esc(opts.buttonLabel || 'Finder') +
      '</button>' +
    '</div>'
  ).join('') + '</div>';
}

function renderWorkspaceLogoFolders() {
  const node = $('workspace-logo-folders');
  if (!node) return;
  node.innerHTML = renderFolderButtons(DATA.logoFolders || []);
  bindRevealButtons(node);
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
    const canReveal = asset.local && asset.relPath;
    const thumb = asset.local && src
      ? '<img class="asset-thumb" src="' + esc(src) + '" alt="" loading="lazy">'
      : '<span class="asset-thumb placeholder">' + esc(assetInitials(asset)) + '</span>';
    return '<div class="asset-card' + (canReveal ? ' has-reveal' : '') + '">' +
      '<a class="asset-link" href="' + esc(href) + '" target="_blank" rel="noreferrer" title="' + esc(asset.field || '') + '">' +
        thumb +
        '<span class="asset-meta">' +
          '<span class="asset-label">' + esc(asset.label || asset.kind) + '</span>' +
          '<span class="asset-kind' + stateClass + '">' + esc(asset.kind) + ' · ' + esc(state) + '</span>' +
          '<span class="asset-path">' + esc(path) + '</span>' +
        '</span>' +
      '</a>' +
      (canReveal ? '<button type="button" class="finder-button asset-reveal" data-reveal-rel="' + esc(asset.relPath) + '" data-copy-fallback="' + esc(asset.relPath) + '">Finder</button>' : '') +
    '</div>';
  };
  const folderBody = renderFolderButtons(DATA.logoFolders || [], { buttonLabel: 'Open' });
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
    '<section class="asset-section"><div class="asset-section-head"><span>Folders</span><span>' + esc((DATA.logoFolders || []).length) + '</span></div>' + folderBody + '</section>' +
    body +
  '</section>';
}

function renderModeTabs(protocol) {
  const counts = protocol.recordView?.logoCounts || {};
  const modeCounts = protocol.view?.modeCounts || {};
  const modes = [
    ['artifact', 'Artifacts', modeCounts.artifact ?? protocol.artifacts.length],
    ['preview', 'Preview', 'UI'],
    ['i18n', 'i18n', i18nLocaleCount(protocol) || protocol.row?.i18n || '-'],
    ['changes', 'Changes', modeCounts.changes ?? (protocol.history || []).length],
    ['assets', 'Logos', modeCounts.assets ?? counts.total ?? 0],
  ];
  if (!modes.some(([id]) => id === state.mode)) state.mode = 'artifact';
  return '<div class="mode-tabs">' + modes.map(([id, label, count]) => {
    const active = state.mode === id ? ' active' : '';
    return '<button class="mode-button' + active + '" data-detail-mode="' + id + '" aria-pressed="' + (state.mode === id ? 'true' : 'false') + '">' +
      esc(label) + ' <span class="metric">' + esc(count) + '</span></button>';
  }).join('') + '</div>';
}

function renderJsonMeta(artifact) {
  const meta = artifact?.jsonMeta;
  if (!meta) return '';
  const chips = [];
  chips.push('shape ' + meta.shape);
  if (Number.isFinite(meta.dataLength)) chips.push('data ' + meta.dataLength);
  const keys = Array.isArray(meta.keys)
    ? meta.keys.map((item) => typeof item === 'string' ? item : item.key + ':' + item.kind)
    : [];
  for (const key of keys.slice(0, 8)) chips.push(key);
  return '<div class="json-meta">' + chips.map((chip) => '<span class="json-chip">' + esc(chip) + '</span>').join('') + '</div>';
}

function readerStats(artifact, content) {
  const source = String(content || '');
  if (!artifact) return 'no file';
  const lines = source ? source.split('\\n').length : 0;
  const kind = artifact.kind === 'json' ? 'JSON reader' : artifact.kind.toUpperCase() + ' reader';
  return '<div class="json-reader-note"><strong>' + esc(kind) + '</strong> · ' +
    esc(lines) + ' lines · ' + esc(artifact.sizeLabel || '') +
    ' · scroll down for the full artifact</div>';
}

function highlightJson(content) {
  const source = String(content || '');
  const token = /("(?:\\\\u[a-fA-F0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(?:true|false)\\b|\\bnull\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g;
  let out = '';
  let last = 0;
  for (const match of source.matchAll(token)) {
    out += esc(source.slice(last, match.index));
    const raw = match[0];
    let cls = 'json-number';
    if (raw === 'true' || raw === 'false') cls = 'json-bool';
    else if (raw === 'null') cls = 'json-null';
    else if (raw.startsWith('"')) cls = raw.trimEnd().endsWith(':') ? 'json-key' : 'json-string';
    out += '<span class="' + cls + '">' + esc(raw) + '</span>';
    last = match.index + raw.length;
  }
  out += esc(source.slice(last));
  return out;
}

function renderArtifactPreview(artifact, content) {
  if (artifact?.kind === 'json' && !artifact.tooLarge) return highlightJson(content);
  return esc(content);
}

function renderArtifactPane(protocol, artifact) {
  const tabs = protocol.artifacts.map((a) => {
    const active = a.name === state.artifact ? ' active' : '';
    return '<button class="artifact-tab' + active + '" data-artifact="' + esc(a.name) + '" aria-pressed="' + (a.name === state.artifact ? 'true' : 'false') + '">' +
      esc(a.label) + ' <span class="metric">' + esc(a.sizeLabel) + '</span></button>';
  }).join('');
  const content = artifact
    ? artifact.tooLarge
      ? 'File is too large to embed in this review page. Use Copy path or Open.'
      : artifact.content
    : 'No artifacts found for this record.';
  return '<div class="artifact-pane">' +
    '<div class="tabs">' + tabs + '</div>' +
    '<div class="reader-tools">' +
      '<div>' + renderJsonMeta(artifact) + readerStats(artifact, content) + '</div>' +
      '<div class="actions">' +
        '<button class="action primary" id="copy-content" ' + (!artifact || artifact.tooLarge ? 'disabled' : '') + '>Copy content</button>' +
        '<button class="action" id="copy-path" ' + (!artifact ? 'disabled' : '') + '>Copy path</button>' +
        '<button class="action" data-reveal-rel="' + esc(artifact?.relPath || '') + '" data-copy-fallback="' + esc(artifact?.path || '') + '" ' + (!artifact ? 'disabled' : '') + '>Show in Finder</button>' +
        (artifact ? '<a class="action" href="' + esc(artifact.href) + '" target="_blank" rel="noreferrer">Open file</a>' : '') +
      '</div>' +
    '</div>' +
    '<div class="preview-wrap">' +
      '<div class="preview-top"><span>' + esc(artifact?.name || 'no file') + '</span><span>' + esc(artifact?.sizeLabel || '') + '</span></div>' +
      '<pre class="preview"><code>' + renderArtifactPreview(artifact, content) + '</code></pre>' +
    '</div>' +
  '</div>';
}

function renderI18nPane(protocol) {
  const info = selectedI18n(protocol);
  const selected = info.selected || info.locales[0];
  const localized = info.record || {};
  const rows = i18nCompareRows(info.source || {}, localized);
  const okCount = info.okCodes.length;
  const failedCount = info.failedCodes.length;
  const requestedCount = info.requestedCodes.length || okCount + failedCount;
  const provider = info.meta.provider || '-';
  const cost = typeof info.meta.cost_usd === 'number' ? '$' + info.meta.cost_usd.toFixed(4) : '-';
  const statusText = protocol.row?.i18n || '-';
  const localeButtons = info.locales.map((locale) => {
    const active = selected && locale.id === selected.id ? ' active' : '';
    const cls = 'locale-button ' + locale.status + active;
    const statusLabel = locale.status === 'failed' ? ' failed' : '';
    return '<button type="button" class="' + cls + '" data-locale="' + esc(locale.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
      esc(locale.label) + '<span class="metric"> ' + esc(locale.dashboardLocale) + statusLabel + '</span></button>';
  }).join('');
  const rowsHtml = rows.length
    ? '<div class="i18n-compare">' +
        '<div class="i18n-row">' +
          '<div class="i18n-cell"><em>Field</em><strong>Source</strong></div>' +
          '<div class="i18n-cell"><em>Base</em><strong>record.json</strong></div>' +
          '<div class="i18n-cell"><em>Locale</em><strong>' + esc(selected?.label || 'Source') + '</strong></div>' +
        '</div>' +
        rows.map((row) =>
          '<div class="i18n-row">' +
            '<div class="i18n-cell"><em>Field</em><strong>' + esc(row.label) + '</strong></div>' +
            '<div class="i18n-cell">' + esc(row.source) + '</div>' +
            '<div class="i18n-cell' + (row.missing ? ' missing' : '') + '">' + esc(row.localized) + '</div>' +
          '</div>'
        ).join('') +
      '</div>'
    : '<div class="empty">No translatable fields found in this record.</div>';
  const fullAction = info.fullArtifact
    ? '<button type="button" class="action" data-artifact="record.full.json">Open full i18n</button>'
    : '<button type="button" class="action" disabled>Open full i18n</button>';
  const summaryText = info.locales.length > 1
    ? 'Switch locales to compare translated fields against the source record.'
    : 'No translated locale is available yet. The source record is still shown for context.';
  return '<div class="scroll-body i18n-pane">' +
    '<section class="i18n-summary">' +
      '<div><p class="mini-title">i18n result</p><h3>' + esc(statusText) + '</h3><p>' + esc(summaryText) + '</p></div>' +
      '<div class="i18n-stats">' +
        '<span><em>OK</em><strong>' + esc(okCount) + '</strong></span>' +
        '<span><em>Failed</em><strong>' + esc(failedCount) + '</strong></span>' +
        '<span><em>Requested</em><strong>' + esc(requestedCount) + '</strong></span>' +
        '<span><em>Cost</em><strong>' + esc(cost) + '</strong></span>' +
      '</div>' +
    '</section>' +
    '<div class="i18n-toolbar">' +
      '<div><div class="locale-switcher">' + localeButtons + '</div><div class="i18n-current">provider ' + esc(provider) + ' · selected ' + esc(selected?.label || 'Source') + ' · dashboard locale ' + esc(selected?.dashboardLocale || 'en') + '</div></div>' +
      '<div class="actions">' +
        '<button type="button" class="action primary" id="copy-i18n-merged">Copy merged locale</button>' +
        '<button type="button" class="action" id="copy-i18n-locale" ' + (selected?.id === 'source' || !selected?.translation ? 'disabled' : '') + '>Copy locale JSON</button>' +
        fullAction +
      '</div>' +
    '</div>' +
    rowsHtml +
  '</div>';
}

function highlightDiff(diffText) {
  return String(diffText || '').split('\\n').map((line) => {
    let cls = 'ctx';
    if (line.startsWith('diff --git ')) cls = 'file';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls = 'meta';
    return '<span class="diff-line ' + cls + '">' + esc(line || ' ') + '</span>';
  }).join('');
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
    ? '<section class="diff"><h3>Diff vs previous</h3>' + statsHtml +
      '<div class="diff-tools"><button class="action" id="copy-diff">Copy diff</button></div>' +
      '<div class="diff-code">' + highlightDiff(protocol.defaultDiff) + '</div></section>'
    : '<section class="diff"><h3>Diff vs previous</h3><div class="empty">No previous commit to compare.</div></section>';
  return '<div class="scroll-body changes-pane">' + historyHtml + diffHtml + '</div>';
}

function renderProtocolPreview(protocol) {
  const record = recordForPreview(protocol);
  const providerLogo = previewLocalLogo(protocol, record.providerLogoUrl, 'provider');
  const logo = logoSrc(providerLogo);
  const title = record.displayName || protocol.view?.title || protocol.slug;
  const members = Array.isArray(record.members) ? record.members : [];
  const fundingRounds = Array.isArray(record.fundingRounds) ? record.fundingRounds : [];
  const auditItems = Array.isArray(record.audits?.items) ? record.audits.items : [];
  const tags = Array.isArray(record.tags) ? record.tags : [];
  const logoHtml = logo
    ? '<img class="preview-logo" src="' + esc(logo) + '" alt="">'
    : '<span class="preview-logo placeholder">' + esc(protocol.view?.initials || assetInitials({ label: title })) + '</span>';
  const links = [
    renderPreviewLink('Website', record.providerWebsite),
    renderPreviewLink('X', record.providerXLink),
    renderPreviewLink('Discord', record.providerDiscordLink),
  ].filter(Boolean).join('');
  const tagHtml = tags.length
    ? '<div class="preview-tags">' + tags.slice(0, 12).map((tag) => '<span class="preview-chip">' + esc(tag) + '</span>').join('') + '</div>'
    : '<div class="preview-tags"><span class="preview-chip">no tags</span></div>';
  const health = [
    ['type', valueOrDash(record.type || protocol.recordView?.type)],
    ['status', valueOrDash(record.status)],
    ['founded', valueOrDash(record.establishment)],
    ['provider', valueOrDash(record.provider || protocol.recordView?.provider)],
  ].map(([label, value]) => '<span><em>' + esc(label) + '</em><strong>' + esc(value) + '</strong></span>').join('');
  const people = members.length
    ? members.slice(0, 12).map((member) => {
        const asset = previewLocalLogo(protocol, member.avatarUrl, 'member');
        const src = logoSrc(asset);
        const avatar = src
          ? '<img class="person-avatar" src="' + esc(src) + '" alt="">'
          : '<span class="person-avatar placeholder">' + esc(assetInitials({ label: member.memberName || 'member' })) + '</span>';
        const memberLinks = [
          renderPreviewLink('X', member.memberLink?.xLink),
          renderPreviewLink('LinkedIn', member.memberLink?.linkedinLink),
        ].filter(Boolean).join('');
        return '<article class="person-card">' + avatar +
          '<div><strong>' + esc(valueOrDash(member.memberName)) + '</strong>' +
          '<p>' + esc(valueOrDash(member.memberPosition)) + '</p>' +
          '<p>' + esc(valueOrDash(member.oneLiner)) + '</p>' +
          (memberLinks ? '<div class="preview-section-tags">' + memberLinks + '</div>' : '') +
          '</div></article>';
      }).join('')
    : '<div class="empty">No team members recorded.</div>';
  const funding = fundingRounds.length
    ? fundingRounds.slice(0, 12).map((round) => {
        const investors = Array.isArray(round.investors) && round.investors.length
          ? round.investors.slice(0, 6).join(', ')
          : 'undisclosed investors';
        return '<article class="funding-row">' +
          '<div><span class="row-kicker">' + esc(valueOrDash(round.date)) + '</span><strong>' + esc(valueOrDash(round.round)) + '</strong></div>' +
          '<p>' + esc(investors) + '</p>' +
          '<div><strong>' + esc(valueOrDash(round.amount)) + '</strong><p>' + esc(valueOrDash(round.valuation)) + '</p></div>' +
        '</article>';
      }).join('')
    : '<div class="empty">No funding rounds recorded.</div>';
  const audits = auditItems.length
    ? auditItems.slice(0, 16).map((audit) => {
        const auditLink = renderPreviewLink('Report', audit.reportUrl);
        return '<article class="audit-row">' +
          '<div><span class="row-kicker">' + esc(valueOrDash(audit.date)) + '</span><strong>' + esc(valueOrDash(audit.auditor)) + '</strong></div>' +
          '<p>' + esc(compactText(audit.scope, 'scope unknown')) + '</p>' +
          '<div>' + (auditLink || '<span class="preview-chip">no report</span>') + '</div>' +
        '</article>';
      }).join('')
    : '<div class="empty">No audits recorded.</div>';
  return '<div class="scroll-body protocol-preview">' +
    '<section class="preview-hero">' +
      logoHtml +
      '<div class="preview-title">' +
        '<div class="preview-section-tags"><span class="preview-chip">Protocol info preview</span></div>' +
        '<h3>' + esc(title) + '</h3>' +
        tagHtml +
        '<p>' + esc(valueOrDash(record.description || protocol.recordView?.description)) + '</p>' +
        (links ? '<div class="preview-links">' + links + '</div>' : '') +
      '</div>' +
      '<div class="preview-health">' + health + '</div>' +
    '</section>' +
    '<section class="preview-section"><div class="preview-section-head"><h3>Team</h3><span>' + esc(listCount(members)) + '</span></div><div class="preview-card-grid">' + people + '</div></section>' +
    '<section class="preview-section"><div class="preview-section-head"><h3>Funding</h3><span>' + esc(listCount(fundingRounds)) + '</span></div><div class="preview-list">' + funding + '</div></section>' +
    '<section class="preview-section"><div class="preview-section-head"><h3>Audit trail</h3><span>' + esc(listCount(auditItems)) + '</span></div><div class="preview-list">' + audits + '</div></section>' +
  '</div>';
}

function renderDetailBody(protocol, artifact) {
  if (state.mode === 'preview') return renderProtocolPreview(protocol);
  if (state.mode === 'i18n') return renderI18nPane(protocol);
  if (state.mode === 'changes') return renderChangesPane(protocol);
  if (state.mode === 'assets') return '<div class="scroll-body">' + renderLogoAssets(protocol) + '</div>';
  return renderArtifactPane(protocol, artifact);
}

function renderDetail() {
  const node = $('detail');
  const protocol = selectedProtocol();
  if (!protocol) {
    node.innerHTML = '<div class="empty">Select a record.</div>';
    return;
  }
  const artifact = selectedArtifact(protocol);
  state.artifact = artifact?.name || state.artifact;
  const recordView = protocol.recordView || {};
  const providerLogo = (recordView.logoAssets || []).find((a) => a.kind === 'provider' && a.local);
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
      '<div class="detail-actions">' +
        '<span class="status ' + (protocol.view?.statusKind || statusClass(protocol.row?.status)) + '">' + esc(protocol.view?.status || protocol.row?.status || '-') + '</span>' +
        '<button type="button" class="finder-button" data-reveal-rel="' + esc(protocol.relDir || protocol.slug) + '" data-copy-fallback="' + esc(protocol.dir || protocol.relDir || protocol.slug) + '">Show folder</button>' +
      '</div>' +
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
  node.querySelectorAll('[data-locale]').forEach((button) => {
    button.addEventListener('click', () => {
      state.locale = button.dataset.locale || 'source';
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
  const copyDiff = $('copy-diff');
  if (copyDiff && protocol.defaultDiff) {
    copyDiff.addEventListener('click', () => copyText(protocol.defaultDiff, protocol.slug + ' diff'));
  }
  const copyI18nLocale = $('copy-i18n-locale');
  if (copyI18nLocale) {
    copyI18nLocale.addEventListener('click', () => {
      const info = selectedI18n(protocol);
      copyText(JSON.stringify(info.selected?.translation || {}, null, 2), (info.selected?.label || 'locale') + ' i18n');
    });
  }
  const copyI18nMerged = $('copy-i18n-merged');
  if (copyI18nMerged) {
    copyI18nMerged.addEventListener('click', () => {
      const info = selectedI18n(protocol);
      copyText(JSON.stringify(info.record || {}, null, 2), (info.selected?.label || 'source') + ' merged record');
    });
  }
  bindRevealButtons(node);
}

function bindRevealButtons(root = document) {
  root.querySelectorAll('[data-reveal-rel]').forEach((button) => {
    if (button.dataset.revealBound === '1') return;
    button.dataset.revealBound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealPath(button.dataset.revealRel || '', button.dataset.copyFallback || '');
    });
  });
}

async function revealPath(relPath, fallbackPath) {
  const rel = String(relPath || '').trim();
  const fallback = String(fallbackPath || rel || '').trim();
  if (!rel) {
    if (fallback) copyText(fallback, 'path');
    else toast('No path');
    return;
  }
  if (!LIVE_DATA_URL) {
    copyText(fallback || rel, 'Finder path');
    return;
  }
  try {
    const res = await fetch('/api/reveal?rel=' + encodeURIComponent(rel), { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    toast('Opened in Finder');
  } catch {
    if (fallback) copyText(fallback, 'Finder path');
    else toast('Finder open failed');
  }
}

function render() {
  renderChrome();
  renderProtocols();
  renderDetail();
  renderWorkspaceLogoFolders();
  bindRevealButtons(document);
}

async function refreshLiveData() {
  if (!LIVE_DATA_URL) return;
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  state.liveStatus = 'checking';
  renderLiveState();
  try {
    const res = await fetch(LIVE_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const next = await res.json();
    state.lastCheckedAt = new Date().toISOString();
    if (!next || next.revision === DATA.revision) {
      state.liveStatus = 'live';
      renderLiveState();
      return;
    }
    const previousSlug = state.slug;
    DATA = next;
    state.liveStatus = 'changed';
    state.lastUpdatedAt = state.lastCheckedAt;
    if (!DATA.protocols.some((p) => p.slug === previousSlug)) {
      state.slug = DATA.protocols[0]?.slug || '';
      state.artifact = DATA.protocols[0]?.view?.defaultArtifact || 'record.import.json';
      state.mode = 'artifact';
      state.locale = 'source';
    }
    render();
    toast('Updated from out/');
  } catch (err) {
    // Keep the current snapshot visible; transient server/file reads should not
    // blank the review UI.
    state.liveStatus = 'error';
    renderLiveState();
  } finally {
    state.refreshInFlight = false;
  }
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

function copyVisibleSummary() {
  // Build a TSV-shaped summary across visible protocols.
  const rows = visibleProtocols().map((p) => p.row || {});
  if (rows.length === 0) return copyText('', 'visible summary');
  const headers = SUMMARY_COLUMNS;
  const tsv = [headers.join('\\t')]
    .concat(rows.map((r) => headers.map((h) => r[h] ?? '').join('\\t')))
    .join('\\n');
  copyText(tsv, 'visible summary');
}

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable;
}

function selectRelative(delta) {
  const protocols = visibleProtocols();
  if (protocols.length === 0) return;
  const current = protocols.findIndex((p) => p.slug === state.slug);
  const nextIndex = current === -1
    ? 0
    : Math.max(0, Math.min(protocols.length - 1, current + delta));
  const next = protocols[nextIndex];
  if (!next || next.slug === state.slug) return;
  state.slug = next.slug;
  state.artifact = next.view?.defaultArtifact || 'record.import.json';
  state.locale = 'source';
  render();
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
  render();
});
document.querySelectorAll('[data-queue-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    state.queueFilter = button.dataset.queueFilter || 'all';
    render();
  });
});
document.addEventListener('keydown', (event) => {
  if (isTypingTarget(event.target)) {
    if (event.key === 'Escape' && event.target === $('query')) {
      state.query = '';
      event.target.value = '';
      event.preventDefault();
      render();
    }
    return;
  }
  if (event.key === '/' && $('query')) {
    event.preventDefault();
    $('query').focus();
    return;
  }
  if (event.key === 'Escape') {
    return;
  }
  if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') {
    event.preventDefault();
    selectRelative(1);
    return;
  }
  if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') {
    event.preventDefault();
    selectRelative(-1);
    return;
  }
  const modeKeys = { '1': 'artifact', '2': 'preview', '3': 'i18n', '4': 'changes', '5': 'assets' };
  if (modeKeys[event.key]) {
    state.mode = modeKeys[event.key];
    event.preventDefault();
    renderDetail();
  }
});
$('copy-root').addEventListener('click', () => copyText(DATA.outputRoot, 'output root'));
$('copy-imports').addEventListener('click', copyVisibleImports);
$('copy-summary').addEventListener('click', copyVisibleSummary);
render();
if (LIVE_DATA_URL) {
  setInterval(refreshLiveData, LIVE_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshLiveData();
  });
}
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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function contentTypeFor(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.tsv') || path.endsWith('.txt') || path.endsWith('.log')) return 'text/plain; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function resolveStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function resolveRevealPath(root, rel) {
  if (!rel || isAbsolute(rel)) return null;
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function revealInFinder(target) {
  const s = await stat(target);
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = s.isDirectory() ? [target] : ['-R', target];
  } else if (process.platform === 'win32') {
    command = 'explorer';
    args = s.isDirectory() ? [target] : [`/select,${target}`];
  } else {
    command = 'xdg-open';
    args = [s.isDirectory() ? target : dirname(target)];
  }
  await new Promise((resolveOpen, rejectOpen) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', rejectOpen);
    child.once('spawn', () => {
      child.unref();
      resolveOpen();
    });
  });
}

export async function startOutBrowserServer({
  outputRoot = DEFAULT_OUT_ROOT,
  host = '127.0.0.1',
  port = 8765,
  logger = console,
} = {}) {
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'Method not allowed');
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const data = await hydrateView(root);
        send(res, 200, renderHtml(data, { liveDataUrl: '/api/out-data' }), 'text/html; charset=utf-8');
        return;
      }
      if (url.pathname === '/api/out-data') {
        const data = await hydrateView(root);
        send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');
        return;
      }
      if (url.pathname === '/api/reveal') {
        if (req.method !== 'GET') {
          send(res, 405, 'Method not allowed');
          return;
        }
        const target = resolveRevealPath(root, url.searchParams.get('rel') || '');
        if (!target) {
          send(res, 403, 'Forbidden');
          return;
        }
        await revealInFinder(target);
        send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
        return;
      }
      const target = resolveStaticPath(root, url.pathname);
      if (!target) {
        send(res, 403, 'Forbidden');
        return;
      }
      const s = await stat(target);
      if (!s.isFile()) {
        send(res, 404, 'Not found');
        return;
      }
      const body = req.method === 'HEAD' ? '' : await readFile(target);
      res.writeHead(200, {
        'Content-Type': contentTypeFor(target),
        'Content-Length': s.size,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      send(res, err?.code === 'ENOENT' ? 404 : 500, err?.code === 'ENOENT' ? 'Not found' : `Server error: ${err.message}`);
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(Number(port), host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const url = `http://${address.address}:${address.port}/`;
  logger?.log?.(`Out browser live server: ${url}`);
  logger?.log?.(`Out root: ${root}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputRoot = arg('out', DEFAULT_OUT_ROOT);
  if (!hasFlag('static')) {
    await startOutBrowserServer({
      outputRoot,
      host: arg('host', '127.0.0.1'),
      port: Number(arg('port', '8765')),
    });
  } else {
    const outputFile = arg('output', join(outputRoot, 'index.html'));
    const file = await buildOutBrowser(outputRoot, { outputFile });
    process.stdout.write(`${file}\n`);
  }
}
