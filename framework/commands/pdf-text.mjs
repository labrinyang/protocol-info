import { join } from 'node:path';
import { readJsonDefault } from '../record-state.mjs';

function usage(stderr) {
  stderr.write('Usage: protocol-info pdf-text <slug> <audit-index>\n');
  stderr.write('  <audit-index> is zero-based and matches audits.items[<index>] in record.json.\n');
}

export default async function pdfTextCmd(args, ctx = {}) {
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const [slug, indexArg] = args;
  if (!outputRoot || !slug || indexArg === undefined) {
    usage(stderr);
    return 1;
  }

  const index = Number(indexArg);
  if (!Number.isInteger(index) || index < 0) {
    stderr.write('pdf-text: <audit-index> must be a zero-based non-negative integer\n');
    return 1;
  }

  const slugDir = join(outputRoot, slug);
  const record = await readJsonDefault(join(slugDir, 'record.json'), null);
  if (!record) {
    stderr.write(`pdf-text: ${join(slugDir, 'record.json')} does not exist or is not valid JSON\n`);
    return 1;
  }

  const audit = record?.audits?.items?.[index];
  if (!audit) {
    const count = Array.isArray(record?.audits?.items) ? record.audits.items.length : 0;
    stderr.write(`pdf-text: audits.items[${index}] does not exist (count=${count})\n`);
    return 1;
  }

  const evidence = await readJsonDefault(join(slugDir, '_debug', 'rootdata.json'), {});
  const reports = evidence?.audit_reports?.reports || [];
  const failures = evidence?.audit_reports?.failures || [];
  const report = reports.find((item) => item?.reportUrl === audit.reportUrl) || null;
  const failure = failures.find((item) => item?.reportUrl === audit.reportUrl)
    || null;

  if (!report?.text_excerpt) {
    stderr.write(`pdf-text: no extracted text found for audits.items[${index}] (${audit.reportUrl || 'no reportUrl'})\n`);
    if (failure?.error) stderr.write(`  extraction failure: ${failure.error}\n`);
    return 1;
  }

  stdout.write([
    `slug: ${slug}`,
    `audit_index: ${index}`,
    `auditor: ${audit.auditor || report.auditor || '-'}`,
    `record_date: ${audit.date || '-'}`,
    `record_scope: ${audit.scope || '-'}`,
    `report_url: ${audit.reportUrl || report.reportUrl || '-'}`,
    `fetched_url: ${report.fetched_url || '-'}`,
    `content_type: ${report.content_type || '-'}`,
    `extraction: ${report.extraction || '-'}`,
    `bytes: ${report.bytes ?? '-'}`,
    `detected_dates: ${(report.detected_dates || []).join(', ') || '-'}`,
    `scope_hints: ${(report.scope_hints || []).slice(0, 5).join(' | ') || '-'}`,
    '',
    report.text_excerpt,
    '',
  ].join('\n'));
  return 0;
}
