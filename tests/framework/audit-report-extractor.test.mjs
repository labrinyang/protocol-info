import { strict as assert } from 'node:assert';
import {
  auditReportUrlsFromRecord,
  candidateReportUrls,
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
    name: 'candidateReportUrls prefers raw GitHub report URLs before blob pages',
    fn: async () => {
      assert.deepEqual(candidateReportUrls('https://github.com/org/repo/blob/main/reports/audit.pdf'), [
        'https://github.com/org/repo/raw/main/reports/audit.pdf',
        'https://raw.githubusercontent.com/org/repo/main/reports/audit.pdf',
        'https://github.com/org/repo/blob/main/reports/audit.pdf',
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
    name: 'collectAuditReportEvidence reads fetched audit text with external OpenAI-compatible LLM when enabled',
    fn: async () => {
      let prompt = '';
      const evidence = await collectAuditReportEvidence({
        record: {
          audits: {
            items: [
              { auditor: 'Zokyo', date: null, scope: null, reportUrl: 'https://github.com/org/repo/blob/main/almanak.pdf' },
            ],
          },
        },
        env: {
          AUDIT_REPORTS_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'gpt-test',
          OPENAI_BASE_URL: 'https://llm.example/v1',
        },
        fetchImpl: async (url) => {
          assert.match(url, /\/raw\/main\/almanak\.pdf$/);
          return response({ contentType: 'application/pdf', body: 'pdf-bytes' });
        },
        extractPdfText: async (_bytes, opts) => {
          assert.equal(opts.maxPages, 25);
          return 'Zokyo Audit\\nDate: 2025-05-06\\nScope: Almanak protocol smart contracts.';
        },
        runLLM: async ({ userPrompt, model, baseUrl, apiKey }) => {
          prompt = userPrompt;
          assert.equal(model, 'gpt-test');
          assert.equal(baseUrl, 'https://llm.example/v1');
          assert.equal(apiKey, 'test-key');
          return {
            model,
            total_cost_usd: null,
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            structured_output: {
              reportTitle: 'Zokyo Audit',
              auditor: 'Zokyo',
              reportDate: '2025-05-06',
              scope: 'Almanak protocol smart contracts',
              executiveSummary: 'Security review of Almanak smart contracts.',
              inScope: ['Almanak protocol smart contracts'],
              findingsSummary: [],
              evidenceQuotes: ['Scope: Almanak protocol smart contracts.'],
              confidence: 0.92,
            },
          };
        },
      });

      assert.match(prompt, /Fetched report text/);
      assert.match(prompt, /Almanak protocol smart contracts/);
      assert.equal(evidence.reports.length, 1);
      assert.equal(evidence.reports[0].fetched_url, 'https://github.com/org/repo/raw/main/almanak.pdf');
      assert.equal(evidence.reports[0].llm_reading.output.reportDate, '2025-05-06');
      assert.deepEqual(evidence.llm, { provider: 'openai', attempted: 1, ok: 1, failed: 0 });
    },
  },
  {
    name: 'collectAuditReportEvidence keeps report evidence when external LLM reading fails',
    fn: async () => {
      const evidence = await collectAuditReportEvidence({
        record: {
          audits: { items: [{ auditor: 'Certora', reportUrl: 'https://example.com/report.html' }] },
        },
        env: {
          AUDIT_REPORTS_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'gpt-test',
        },
        fetchImpl: async () => response({
          contentType: 'text/html',
          body: '<html><body>Certora Audit Scope: Vault contracts. 2024-06</body></html>',
        }),
        runLLM: async () => {
          throw new Error('gateway down');
        },
      });
      assert.equal(evidence.reports.length, 1);
      assert.match(evidence.reports[0].llm_error, /gateway down/);
      assert.deepEqual(evidence.llm, { provider: 'openai', attempted: 1, ok: 0, failed: 1 });
    },
  },
  {
    name: 'collectAuditReportEvidence lets external LLM read beyond deterministic excerpt',
    fn: async () => {
      let prompt = '';
      const lateText = 'late findings table: critical issue summary';
      const evidence = await collectAuditReportEvidence({
        record: {
          audits: { items: [{ auditor: 'Long Report', reportUrl: 'https://example.com/report.txt' }] },
        },
        env: {
          AUDIT_REPORTS_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'gpt-test',
        },
        fetchImpl: async () => response({
          contentType: 'text/plain',
          body: `short intro ${'x'.repeat(80)} ${lateText}`,
        }),
        maxTextChars: 20,
        maxLLMTextChars: 160,
        runLLM: async ({ userPrompt }) => {
          prompt = userPrompt;
          return {
            model: 'gpt-test',
            structured_output: {
              reportTitle: null,
              auditor: 'Long Report',
              reportDate: null,
              scope: null,
              executiveSummary: null,
              inScope: [],
              findingsSummary: ['critical issue summary'],
              evidenceQuotes: [lateText],
              confidence: 0.8,
            },
          };
        },
      });
      assert.doesNotMatch(evidence.reports[0].text_excerpt, /late findings table/);
      assert.match(prompt, /late findings table/);
      assert.equal(evidence.reports[0].llm_reading.output.findingsSummary[0], 'critical issue summary');
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
      const cleared = mergeAuditReportEvidence(
        { audit_reports: { reports: [{ reportUrl: 'old' }], failures: [] }, rootdata: { ok: true } },
        { reports: [], failures: [] },
      );
      assert.deepEqual(cleared.audit_reports, { reports: [], failures: [] });
    },
  },
];
