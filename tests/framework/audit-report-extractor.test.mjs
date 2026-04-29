import { strict as assert } from 'node:assert';
import {
  auditReportUrlsFromRecord,
  collectAuditReportEvidence,
  detectDateHints,
  detectScopeHints,
  mergeAuditReportEvidence,
} from '../../framework/audit-report-extractor.mjs';

function response({ contentType, body, ok = true, status = 200, contentLength = null }) {
  return {
    ok,
    status,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return contentLength;
        return null;
      },
    },
    text: async () => String(body),
    arrayBuffer: async () => Buffer.from(String(body)).buffer,
  };
}

export const tests = [
  {
    name: 'auditReportUrlsFromRecord returns unique report URLs with record context',
    fn: async () => {
      const urls = auditReportUrlsFromRecord({
        audits: {
          items: [
            { auditor: 'OpenZeppelin', date: '2024-05', scope: 'Core contracts', reportUrl: 'https://example.com/a.pdf' },
            { auditor: 'OpenZeppelin', date: '2024-05', scope: 'Duplicate', reportUrl: 'https://example.com/a.pdf' },
            { auditor: 'Bad', reportUrl: 'not a url' },
          ],
        },
      });
      assert.deepEqual(urls, [
        {
          auditor: 'OpenZeppelin',
          reportUrl: 'https://example.com/a.pdf',
          recordDate: '2024-05',
          recordScope: 'Core contracts',
        },
      ]);
    },
  },
  {
    name: 'collectAuditReportEvidence extracts PDF text and hints without real pdftotext',
    fn: async () => {
      const evidence = await collectAuditReportEvidence({
        record: {
          audits: {
            items: [
              { auditor: 'Trail of Bits', date: '2023-01', scope: null, reportUrl: 'https://example.com/report.pdf' },
            ],
          },
        },
        fetchImpl: async () => response({ contentType: 'application/pdf', body: 'pdf-bytes' }),
        extractPdfText: async () => `
Trail of Bits Security Assessment
Date: May 9, 2024
Audit Scope: Core protocol contracts and staking module
This report reviews the protocol smart contracts.
`,
      });

      assert.equal(evidence.reports.length, 1);
      assert.equal(evidence.failures.length, 0);
      assert.equal(evidence.reports[0].auditor, 'Trail of Bits');
      assert.deepEqual(evidence.reports[0].detected_dates, ['2024-05-09']);
      assert.ok(evidence.reports[0].scope_hints.some((line) => line.includes('Core protocol contracts')));
      assert.match(evidence.reports[0].text_excerpt, /Security Assessment/);
      assert.equal(evidence.reports[0].extraction, 'pdf');
    },
  },
  {
    name: 'collectAuditReportEvidence strips HTML report pages and records failures',
    fn: async () => {
      let calls = 0;
      const evidence = await collectAuditReportEvidence({
        record: {
          audits: {
            items: [
              { auditor: 'Certora', reportUrl: 'https://example.com/report' },
              { auditor: 'Spearbit', reportUrl: 'https://example.com/missing.pdf' },
            ],
          },
        },
        fetchImpl: async (url) => {
          calls += 1;
          if (url.includes('missing')) return response({ ok: false, status: 404, contentType: 'text/plain', body: '' });
          return response({
            contentType: 'text/html',
            body: '<html><script>bad()</script><body><h1>Certora Audit</h1><p>Scope: Vault contracts.</p><p>2024-06</p></body></html>',
          });
        },
      });

      assert.equal(calls, 2);
      assert.equal(evidence.reports.length, 1);
      assert.equal(evidence.failures.length, 1);
      assert.equal(evidence.failures[0].error, 'HTTP 404');
      assert.deepEqual(evidence.reports[0].detected_dates, ['2024-06']);
      assert.doesNotMatch(evidence.reports[0].text_excerpt, /script/);
    },
  },
  {
    name: 'collectAuditReportEvidence records oversized report failures',
    fn: async () => {
      const evidence = await collectAuditReportEvidence({
        record: {
          audits: {
            items: [
              { auditor: 'Big Report', reportUrl: 'https://example.com/huge.html' },
            ],
          },
        },
        fetchImpl: async () => response({
          contentType: 'text/html',
          contentLength: '5000',
          body: '<html>large</html>',
        }),
        maxBytes: 100,
      });

      assert.equal(evidence.reports.length, 0);
      assert.equal(evidence.failures.length, 1);
      assert.match(evidence.failures[0].error, /report too large/);
    },
  },
  {
    name: 'hint detection and evidence merge are deterministic',
    fn: async () => {
      assert.deepEqual(detectDateHints('Reviewed on 2024/7/3 and July 10, 2025.'), ['2024-07-03', '2025-07-10']);
      assert.deepEqual(
        detectScopeHints('short\nScope: Core contracts and oracle modules were assessed.'),
        ['Scope: Core contracts and oracle modules were assessed.'],
      );
      const merged = mergeAuditReportEvidence({ rootdata: { ok: true } }, { reports: [{ reportUrl: 'x' }], failures: [] });
      assert.deepEqual(merged.audit_reports.reports, [{ reportUrl: 'x' }]);
      assert.deepEqual(merged.rootdata, { ok: true });
    },
  },
];
