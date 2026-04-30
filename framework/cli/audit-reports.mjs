// Enrich an evidence packet with deterministic text extracted from audit
// report URLs already found in record.json. This runs after R1 audits discover
// reportUrl values and before R2 reconcile evaluates date/scope quality.

import { readFile, writeFile } from 'node:fs/promises';
import { collectAuditReportEvidence, mergeAuditReportEvidence } from '../audit-report-extractor.mjs';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const recordIn = arg('record-in');
const evidenceIn = arg('evidence-in');
const evidenceOut = arg('evidence-out', evidenceIn);

if (!recordIn || !evidenceIn || !evidenceOut) {
  console.error('usage: audit-reports.mjs --record-in R --evidence-in E --evidence-out E2');
  process.exit(2);
}

let record;
let evidence;
try {
  record = JSON.parse(await readFile(recordIn, 'utf8'));
  evidence = JSON.parse(await readFile(evidenceIn, 'utf8'));
} catch (err) {
  console.error(`[audit-reports] input read failed: ${err.message}`);
  process.exit(1);
}

const auditReports = await collectAuditReportEvidence({ record, env: process.env });
const nextEvidence = mergeAuditReportEvidence(evidence, auditReports);
await writeFile(evidenceOut, JSON.stringify(nextEvidence, null, 2));

const reportCount = auditReports.reports?.length || 0;
const failureCount = auditReports.failures?.length || 0;
const llmSuffix = auditReports.llm
  ? ` llm=${auditReports.llm.provider}:${auditReports.llm.ok}/${auditReports.llm.attempted}`
  : '';
console.error(`[audit-reports] extracted=${reportCount} failed=${failureCount}${llmSuffix}`);
process.exit(0);
