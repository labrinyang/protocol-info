import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRefreshSubtask } from '../../framework/refresh-runner.mjs';

const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');

export const tests = [
  {
    name: 'runRefreshSubtask renders real subtask inputs and calls runSubtask',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-refresh-runner-'));
      await mkdir(join(out, 'pendle', '_debug'), { recursive: true });
      await writeFile(join(out, 'pendle', '_debug', 'rootdata.json'), JSON.stringify({
        rootdata: {
          api_funding: [{ round: 'Seed', amount: '$1M' }],
          ignored: true,
        },
      }));
      let call = null;
      const result = await runRefreshSubtask({
        slug: 'pendle',
        subtaskName: 'funding',
        existingRecord: { name: 'Pendle', fundingRounds: [] },
        manifestPath,
        outputRoot: out,
        runSubtask: async (args) => {
          call = args;
          return {
            ok: true,
            slice: { fundingRounds: [{ round: 'Seed' }] },
            findings: [{ field: 'fundingRounds', confidence: 0.9 }],
            gaps: [],
          };
        },
      });

      assert.equal(call.subtask.name, 'funding');
      assert.equal(call.outputKey, 'slice');
      assert.ok(call.schemaSlice.properties.fundingRounds);
      assert.ok(call.findingsSchema.items);
      assert.ok(call.gapsSchema.items);
      assert.match(call.userPrompt, /"existing_record"/);
      assert.match(call.userPrompt, /"fundingRounds": \[\]/);
      assert.match(call.userPrompt, /"api_funding"/);
      assert.doesNotMatch(call.userPrompt, /ignored/);
      assert.deepEqual(result.changes, []);
      assert.equal(result.slice.fundingRounds[0].round, 'Seed');
    },
  },
  {
    name: 'runRefreshSubtask injects extracted audit report evidence for audits refresh',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-refresh-runner-'));
      await mkdir(join(out, 'pendle', '_debug'), { recursive: true });
      await writeFile(join(out, 'pendle', '_debug', 'rootdata.json'), JSON.stringify({
        audit_reports: { reports: [{ reportUrl: 'https://old.example/report.pdf' }] },
      }));
      let prompt = '';
      const result = await runRefreshSubtask({
        slug: 'pendle',
        subtaskName: 'audits',
        existingRecord: {
          displayName: 'Pendle',
          audits: {
            items: [
              { auditor: 'OpenZeppelin', reportUrl: 'https://example.com/pendle.pdf' },
            ],
          },
        },
        manifestPath,
        outputRoot: out,
        collectAuditReports: async ({ record }) => {
          assert.equal(record.audits.items[0].auditor, 'OpenZeppelin');
          return {
            reports: [
              {
                auditor: 'OpenZeppelin',
                reportUrl: 'https://example.com/pendle.pdf',
                text_excerpt: 'Scope: Core Pendle contracts. Date: 2024-05.',
              },
            ],
            failures: [],
          };
        },
        runSubtask: async (args) => {
          prompt = args.userPrompt;
          return {
            ok: true,
            slice: { audits: { items: [], lastScannedAt: '1970-01-01' } },
            findings: [],
            gaps: [],
          };
        },
      });

      assert.match(prompt, /"existing_record"/);
      assert.match(prompt, /"audit_reports"/);
      assert.match(prompt, /Core Pendle contracts/);
      assert.doesNotMatch(prompt, /old\.example/);
      assert.deepEqual(result.changes, []);
    },
  },
  {
    name: 'runRefreshSubtask rejects unknown subtask',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-refresh-runner-'));
      await assert.rejects(
        () => runRefreshSubtask({
          slug: 'pendle',
          subtaskName: 'bogus',
          existingRecord: { name: 'Pendle' },
          manifestPath,
          outputRoot: out,
          runSubtask: async () => ({ ok: true }),
        }),
        /unknown subtask/
      );
    },
  },
];
