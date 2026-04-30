import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runOpenAIChatCompletion } from './openai-wrapper.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_REPORTS = 12;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 30_000;
const DEFAULT_MAX_LLM_TEXT_CHARS = 45_000;
const DEFAULT_MAX_PDF_PAGES = 25;

const AUDIT_REPORT_READING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reportTitle',
    'auditor',
    'reportDate',
    'scope',
    'executiveSummary',
    'inScope',
    'findingsSummary',
    'evidenceQuotes',
    'confidence',
  ],
  properties: {
    reportTitle: { type: ['string', 'null'] },
    auditor: { type: ['string', 'null'] },
    reportDate: { type: ['string', 'null'] },
    scope: { type: ['string', 'null'] },
    executiveSummary: { type: ['string', 'null'] },
    inScope: { type: 'array', items: { type: 'string' } },
    findingsSummary: { type: 'array', items: { type: 'string' } },
    evidenceQuotes: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

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

function githubRawCandidates(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (!/^github\.com$/i.test(parsed.hostname)) return [];
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 5) return [];
  const [owner, repo, marker, ...rest] = parts;
  if (marker !== 'blob' && marker !== 'raw') return [];
  const path = rest.join('/');
  if (!path) return [];
  return [
    `https://github.com/${owner}/${repo}/raw/${path}${parsed.search || ''}`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${path}${parsed.search || ''}`,
  ];
}

export function candidateReportUrls(url) {
  const candidates = [];
  for (const candidate of [...githubRawCandidates(url), url]) {
    if (isHttpUrl(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
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
  const candidates = candidateReportUrls(entry.reportUrl);
  let lastErr = null;
  for (const candidateUrl of candidates) {
    try {
      const response = await fetchImpl(candidateUrl, {
        headers: { 'User-Agent': 'protocol-info/2.3 audit-report-extractor' },
        signal: AbortSignal.timeout?.(30_000),
      });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);

      const length = contentLength(response.headers);
      if (length != null && length > maxBytes) throw new Error(`report too large (${length} bytes)`);

      const type = contentType(response.headers);
      const isPdf = type === 'application/pdf' || isLikelyPdfUrl(candidateUrl) || isLikelyPdfUrl(entry.reportUrl);
      if (isPdf) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error(`PDF too large (${bytes.length} bytes)`);
        return {
          text: await extractPdfText(bytes, { maxPages: maxPdfPages }),
          contentType: type || 'application/pdf',
          extraction: 'pdf',
          bytes: bytes.length,
          fetchedUrl: candidateUrl,
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
        fetchedUrl: candidateUrl,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no fetchable report URL');
}

function resolveAuditReportLLMProvider(env = {}) {
  const value = env.AUDIT_REPORTS_LLM_PROVIDER
    || env.AUDIT_REPORT_LLM_PROVIDER
    || env.REFRESH_AUDITS_LLM_PROVIDER
    || '';
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === 'none' || normalized === 'off' || normalized === 'false') return null;
  return normalized;
}

function auditReportLLMSystemPrompt() {
  return [
    'You are an audit-report evidence reader for protocol-info.',
    'Use only the supplied fetched report text and record context.',
    'Extract exact, reviewable facts. If the report text does not support a field, return null or an empty array.',
    'Do not infer from protocol knowledge outside the supplied text.',
  ].join('\n');
}

function auditReportLLMUserPrompt(report, text) {
  return [
    'Read this audit report text carefully and return structured evidence.',
    '',
    'Record context:',
    JSON.stringify({
      auditor: report.auditor,
      reportUrl: report.reportUrl,
      record_date: report.record_date,
      record_scope: report.record_scope,
      title_hint: report.title_hint,
      detected_dates: report.detected_dates,
      scope_hints: report.scope_hints,
    }, null, 2),
    '',
    'Factual extraction rules:',
    '- reportDate must be ISO-like YYYY-MM-DD, YYYY-MM, or null.',
    '- scope should describe audited contracts/modules/systems, not a marketing summary.',
    '- findingsSummary should summarize concrete issue categories or say no issues only if the text says so.',
    '- evidenceQuotes must be short direct excerpts from the supplied text.',
    '',
    'Fetched report text:',
    '```text',
    text,
    '```',
  ].join('\n');
}

async function readReportWithExternalLLM(report, {
  env = {},
  runLLM = runOpenAIChatCompletion,
  reportText = '',
  maxLLMTextChars = DEFAULT_MAX_LLM_TEXT_CHARS,
}) {
  const provider = resolveAuditReportLLMProvider(env);
  if (!provider) return null;
  if (provider !== 'openai') {
    throw new Error(`unsupported audit report LLM provider "${provider}"`);
  }
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for audit report LLM reading');
  const model = env.AUDIT_REPORTS_OPENAI_MODEL || env.AUDIT_REPORT_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-5.5';
  const text = String(reportText || report.text_excerpt || '').slice(0, maxLLMTextChars);
  if (!text.trim()) throw new Error('no audit report text for LLM reading');
  const envelope = await runLLM({
    systemPrompt: auditReportLLMSystemPrompt(),
    userPrompt: auditReportLLMUserPrompt(report, text),
    schemaJson: AUDIT_REPORT_READING_SCHEMA,
    model,
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY,
    strictSchema: false,
  });
  return {
    provider,
    model: envelope.model || model,
    output: envelope.structured_output,
    usage: envelope.usage || null,
    cost_usd: envelope.total_cost_usd ?? null,
  };
}

export async function collectAuditReportEvidence({
  record,
  fetchImpl = globalThis.fetch,
  extractPdfText = extractPdfTextWithPdftotext,
  env = {},
  runLLM = runOpenAIChatCompletion,
  maxReports = DEFAULT_MAX_REPORTS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  maxLLMTextChars = DEFAULT_MAX_LLM_TEXT_CHARS,
  maxPdfPages = DEFAULT_MAX_PDF_PAGES,
} = {}) {
  const entries = auditReportUrlsFromRecord(record).slice(0, maxReports);
  const reports = [];
  const failures = [];
  const llmProvider = resolveAuditReportLLMProvider(env);
  const llm = {
    provider: llmProvider,
    attempted: 0,
    ok: 0,
    failed: 0,
  };

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
      const report = {
        auditor: entry.auditor,
        reportUrl: entry.reportUrl,
        fetched_url: fetched.fetchedUrl || entry.reportUrl,
        record_date: entry.recordDate,
        record_scope: entry.recordScope,
        title_hint: firstTitleLine(text),
        detected_dates: detectDateHints(text),
        scope_hints: detectScopeHints(text),
        text_excerpt: text.slice(0, maxTextChars),
        content_type: fetched.contentType,
        extraction: fetched.extraction,
        bytes: fetched.bytes,
      };
      if (llmProvider) {
        llm.attempted += 1;
        try {
          report.llm_reading = await readReportWithExternalLLM(report, {
            env,
            runLLM,
            reportText: text,
            maxLLMTextChars,
          });
          if (report.llm_reading) llm.ok += 1;
        } catch (err) {
          llm.failed += 1;
          report.llm_error = err.message;
        }
      }
      reports.push(report);
    } catch (err) {
      failures.push({ ...entry, error: err.message });
    }
  }

  const out = { reports, failures, extracted_at: new Date().toISOString() };
  if (llmProvider) out.llm = llm;
  return out;
}

export function mergeAuditReportEvidence(evidence, auditReports) {
  if (!auditReports) return evidence || {};
  return {
    ...(evidence || {}),
    audit_reports: auditReports,
  };
}
