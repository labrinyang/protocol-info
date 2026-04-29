import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_REPORTS = 8;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 6_000;
const DEFAULT_MAX_PDF_PAGES = 4;

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isLikelyPdfUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function contentType(headers) {
  return headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
}

function contentLength(headers) {
  const raw = headers?.get?.('content-length');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function compactText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtml(html) {
  return compactText(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"'));
}

function normalizeDate(year, month, day = '') {
  const mm = String(month).padStart(2, '0');
  if (day) return `${year}-${mm}-${String(day).padStart(2, '0')}`;
  return `${year}-${mm}`;
}

export function detectDateHints(text, limit = 10) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const numeric = /\b(20\d{2})[-/.](0?[1-9]|1[0-2])(?:[-/.]([0-3]?\d))?\b/g;
  for (const match of String(text || '').matchAll(numeric)) {
    add(normalizeDate(match[1], match[2], match[3] || ''));
    if (out.length >= limit) return out;
  }

  const months = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', sept: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  };
  const monthName = /\b(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+([0-3]?\d,?\s+)?(20\d{2})\b/gi;
  for (const match of String(text || '').matchAll(monthName)) {
    const month = months[match[1].toLowerCase()];
    const day = (match[2] || '').replace(/[^0-9]/g, '');
    add(normalizeDate(match[3], month, day));
    if (out.length >= limit) return out;
  }

  return out;
}

export function detectScopeHints(text, limit = 8) {
  const lines = compactText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 16 && line.length <= 240);
  const scored = [];
  const seen = new Set();
  for (const line of lines) {
    const normalized = line.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    let score = 0;
    if (/\bscope\b|\bin scope\b|\baudit scope\b/i.test(line)) score += 4;
    if (/\bcontracts?\b|\bmodules?\b|\bcodebase\b|\bprotocol\b|\bsystem\b/i.test(line)) score += 2;
    if (/\baudit\b|\breview\b|\bassessment\b|\bsecurity\b/i.test(line)) score += 1;
    if (score > 0) scored.push({ line, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.line);
}

function firstTitleLine(text) {
  return compactText(text)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length >= 5 && line.length <= 180) || '';
}

export async function extractPdfTextWithPdftotext(bytes, {
  maxPages = DEFAULT_MAX_PDF_PAGES,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-audit-pdf-'));
  const input = join(dir, 'report.pdf');
  try {
    await writeFile(input, bytes);
    const { stdout } = await execFileAsync('pdftotext', [
      '-f', '1',
      '-l', String(maxPages),
      '-layout',
      input,
      '-',
    ], { maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function auditReportUrlsFromRecord(record) {
  const urls = [];
  const seen = new Set();
  for (const item of record?.audits?.items || []) {
    const url = item?.reportUrl;
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push({
      auditor: item?.auditor || null,
      reportUrl: url,
      recordDate: item?.date || null,
      recordScope: item?.scope ?? null,
    });
  }
  return urls;
}

async function fetchReportText(entry, {
  fetchImpl,
  extractPdfText,
  maxBytes,
  maxPdfPages,
}) {
  const response = await fetchImpl(entry.reportUrl, {
    headers: { 'User-Agent': 'protocol-info/2.1 audit-report-extractor' },
    signal: AbortSignal.timeout?.(30_000),
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);

  const length = contentLength(response.headers);
  if (length != null && length > maxBytes) throw new Error(`report too large (${length} bytes)`);

  const type = contentType(response.headers);
  const isPdf = type === 'application/pdf' || isLikelyPdfUrl(entry.reportUrl);
  if (isPdf) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`PDF too large (${bytes.length} bytes)`);
    return {
      text: await extractPdfText(bytes, { maxPages: maxPdfPages }),
      contentType: type || 'application/pdf',
      extraction: 'pdf',
      bytes: bytes.length,
    };
  }

  const raw = await response.text();
  const bytes = Buffer.byteLength(raw);
  if (bytes > maxBytes) throw new Error(`report too large (${bytes} bytes)`);
  const text = type === 'text/html' || raw.includes('<html')
    ? stripHtml(raw)
    : compactText(raw);
  return {
    text,
    contentType: type || 'text/plain',
    extraction: type === 'text/html' ? 'html' : 'text',
    bytes,
  };
}

export async function collectAuditReportEvidence({
  record,
  fetchImpl = globalThis.fetch,
  extractPdfText = extractPdfTextWithPdftotext,
  maxReports = DEFAULT_MAX_REPORTS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  maxPdfPages = DEFAULT_MAX_PDF_PAGES,
} = {}) {
  const entries = auditReportUrlsFromRecord(record).slice(0, maxReports);
  const reports = [];
  const failures = [];

  if (entries.length === 0) {
    return { reports, failures, extracted_at: new Date().toISOString() };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      reports,
      failures: entries.map((entry) => ({ ...entry, error: 'fetch_unavailable' })),
      extracted_at: new Date().toISOString(),
    };
  }

  for (const entry of entries) {
    try {
      const fetched = await fetchReportText(entry, {
        fetchImpl,
        extractPdfText,
        maxBytes,
        maxPdfPages,
      });
      const text = compactText(fetched.text);
      if (!text) throw new Error('no extractable text');
      reports.push({
        auditor: entry.auditor,
        reportUrl: entry.reportUrl,
        record_date: entry.recordDate,
        record_scope: entry.recordScope,
        title_hint: firstTitleLine(text),
        detected_dates: detectDateHints(text),
        scope_hints: detectScopeHints(text),
        text_excerpt: text.slice(0, maxTextChars),
        content_type: fetched.contentType,
        extraction: fetched.extraction,
        bytes: fetched.bytes,
      });
    } catch (err) {
      failures.push({ ...entry, error: err.message });
    }
  }

  return { reports, failures, extracted_at: new Date().toISOString() };
}

export function mergeAuditReportEvidence(evidence, auditReports) {
  if (!auditReports || (!auditReports.reports?.length && !auditReports.failures?.length)) return evidence || {};
  return {
    ...(evidence || {}),
    audit_reports: auditReports,
  };
}
