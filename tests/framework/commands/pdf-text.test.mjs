import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tests = [
  {
    name: 'pdf-text prints extracted audit report text for record audit index',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-pdf-text-'));
      const slugDir = join(out, 'pendle');
      await mkdir(join(slugDir, '_debug'), { recursive: true });
      await writeFile(join(slugDir, 'record.json'), JSON.stringify({
        audits: {
          items: [
            {
              auditor: 'OpenZeppelin',
              date: '2024-05',
              scope: 'V3 contracts',
              reportUrl: 'https://example.com/report.pdf',
            },
          ],
        },
      }));
      await writeFile(join(slugDir, '_debug', 'rootdata.json'), JSON.stringify({
        audit_reports: {
          reports: [
            {
              auditor: 'OpenZeppelin',
              reportUrl: 'https://example.com/report.pdf',
              fetched_url: 'https://example.com/report.pdf',
              text_excerpt: 'Scope: V3 contracts\nDate: May 2024',
              content_type: 'application/pdf',
              extraction: 'pdf',
              bytes: 1234,
              detected_dates: ['2024-05'],
              scope_hints: ['Scope: V3 contracts'],
            },
          ],
          failures: [],
        },
      }));

      let stdout = '';
      let stderr = '';
      const cmd = (await import('../../../framework/commands/pdf-text.mjs')).default;
      const code = await cmd(['pendle', '0'], {
        outputRoot: out,
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
      });
      assert.equal(code, 0);
      assert.equal(stderr, '');
      assert.match(stdout, /auditor: OpenZeppelin/);
      assert.match(stdout, /detected_dates: 2024-05/);
      assert.match(stdout, /Scope: V3 contracts/);
    },
  },
  {
    name: 'pdf-text fails instead of falling back to mismatched extracted report text',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-pdf-text-mismatch-'));
      const slugDir = join(out, 'pendle');
      await mkdir(join(slugDir, '_debug'), { recursive: true });
      await writeFile(join(slugDir, 'record.json'), JSON.stringify({
        audits: {
          items: [
            {
              auditor: 'OpenZeppelin',
              reportUrl: 'https://example.com/current.pdf',
            },
          ],
        },
      }));
      await writeFile(join(slugDir, '_debug', 'rootdata.json'), JSON.stringify({
        audit_reports: {
          reports: [
            {
              auditor: 'Other Auditor',
              reportUrl: 'https://example.com/stale.pdf',
              text_excerpt: 'This stale report text must not be printed',
            },
          ],
          failures: [],
        },
      }));

      let stdout = '';
      let stderr = '';
      const cmd = (await import('../../../framework/commands/pdf-text.mjs')).default;
      const code = await cmd(['pendle', '0'], {
        outputRoot: out,
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
      });
      assert.equal(code, 1);
      assert.equal(stdout, '');
      assert.match(stderr, /no extracted text found/);
      assert.match(stderr, /current\.pdf/);
      assert.doesNotMatch(stderr, /stale report text/);
    },
  },
];
