import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureRepo, commit, isClean, log } from '../../../framework/version-store.mjs';

async function seedOut() {
  const out = await mkdtemp(join(tmpdir(), 'pi-refresh-cmd-'));
  await ensureRepo(out);
  await mkdir(join(out, 'pendle'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
    name: 'Pendle',
    description: 'old',
    status: 'active',
    fundingRounds: [{ round: 'Seed', amount: '$1M' }],
  }) + '\n');
  await writeFile(join(out, 'pendle', 'findings.json'), JSON.stringify([
    { field: 'fundingRounds', value: 'seed only', source: 'prior', confidence: 0.9, method: 'prior' },
  ]) + '\n');
  await writeFile(join(out, 'pendle', 'changes.json'), '[]\n');
  await writeFile(join(out, 'pendle', 'gaps.json'), '[]\n');
  await commit(out, { paths: ['pendle/'], message: 'crawl(pendle): ok', runId: 'R-prior' });
  return out;
}

async function commitOnly(outputRoot, { slug, message, runId }) {
  return {
    sha: await commit(outputRoot, { paths: [`${slug}/`], message, runId }),
    browserPath: null,
  };
}

async function normalizeNoop(envelope) {
  return envelope;
}

async function addI18nArtifacts(out) {
  await mkdir(join(out, 'pendle', '_debug', 'i18n'), { recursive: true });
  await writeFile(join(out, 'pendle', '_debug', 'i18n', 'zh_CN.json'), '{"description":"old zh"}\n');
  await writeFile(join(out, 'pendle', 'record.full.json'), '{"description":"old","i18n":{"zh_CN":{"description":"old zh"}}}\n');
  await writeFile(join(out, 'pendle', 'meta.json'), '{"status":"OK","i18n":{"locales_ok":["zh_CN"]}}\n');
  await commit(out, { paths: ['pendle/'], message: 'i18n(pendle): zh_CN', runId: 'R-i18n' });
}

export const tests = [
  {
    name: 'refresh wraps subtask result as envelope, writes merged.record, and commits',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/refresh.mjs')).default;
      const code = await cmd(['pendle', 'funding'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        runRefreshSubtask: async ({ slug, subtaskName, existingRecord }) => {
          assert.equal(slug, 'pendle');
          assert.equal(subtaskName, 'funding');
          assert.equal(existingRecord.fundingRounds.length, 1);
          return {
            ok: true,
            slice: {
              fundingRounds: [
                { round: 'Seed', amount: '$1M' },
                { round: 'Series A', amount: '$5M' },
              ],
            },
            findings: [{ field: 'fundingRounds', value: 'series a', source: 'source', confidence: 0.95, method: 'press' }],
            changes: [{ field: 'fundingRounds', before: [], after: [], reason: 'new cited round', confidence: 0.95 }],
            gaps: [],
          };
        },
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.name, 'Pendle');
      assert.equal(record.fundingRounds.length, 2);
      assert.equal(record.record, undefined, 'must write merged.record, not merge wrapper');
      const changes = JSON.parse(await readFile(join(out, 'pendle', 'changes.json'), 'utf8'));
      assert.equal(changes[0].field, 'fundingRounds');
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist[0].message, 'refresh(pendle): funding');
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'refresh mergeR2 suppresses uncited high-confidence overwrite',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/refresh.mjs')).default;
      const code = await cmd(['pendle', 'funding'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        runRefreshSubtask: async () => ({
          ok: true,
          slice: { fundingRounds: [{ round: 'Series A', amount: '$5M' }] },
          findings: [],
          changes: [],
          gaps: [],
        }),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async () => 0,
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.deepEqual(record.fundingRounds, [{ round: 'Seed', amount: '$1M' }]);
      const gaps = JSON.parse(await readFile(join(out, 'pendle', 'gaps.json'), 'utf8'));
      assert.match(gaps.at(-1).reason, /suppressed/);
    },
  },
  {
    name: 'refresh preserves i18n artifacts when translatable fields do not change',
    fn: async () => {
      const out = await seedOut();
      await addI18nArtifacts(out);
      const cmd = (await import('../../../framework/commands/refresh.mjs')).default;
      const code = await cmd(['pendle', 'funding'], {
        outputRoot: out,
        manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
        runRefreshSubtask: async () => ({
          ok: true,
          slice: {
            fundingRounds: [
              { round: 'Seed', amount: '$1M' },
              { round: 'Series A', amount: '$5M' },
            ],
          },
          findings: [{ field: 'fundingRounds', value: 'series a', source: 'source', confidence: 0.95 }],
          changes: [{ field: 'fundingRounds', before: [], after: [], reason: 'new cited round', confidence: 0.95 }],
          gaps: [],
        }),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'zh_CN.json')), true);
          assert.equal(existsSync(join(slugDir, 'record.full.json')), true);
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.equal(existsSync(join(out, 'pendle', '_debug', 'i18n', 'zh_CN.json')), true);
      assert.equal(existsSync(join(out, 'pendle', 'record.full.json')), true);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'refresh invalidates i18n artifacts when translatable fields change',
    fn: async () => {
      const out = await seedOut();
      await addI18nArtifacts(out);
      const cmd = (await import('../../../framework/commands/refresh.mjs')).default;
      const code = await cmd(['pendle', 'metadata'], {
        outputRoot: out,
        manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
        runRefreshSubtask: async () => ({
          ok: true,
          slice: { description: 'new' },
          findings: [{ field: 'description', value: 'new', source: 'source', confidence: 0.95 }],
          changes: [{ field: 'description', before: 'old', after: 'new', reason: 'verified', confidence: 0.95 }],
          gaps: [],
        }),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'zh_CN.json')), false);
          assert.equal(existsSync(join(slugDir, 'record.full.json')), false);
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      assert.equal(existsSync(join(out, 'pendle', 'record.full.json')), false);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'refresh preserves existing lifecycle status from automated metadata slices',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/refresh.mjs')).default;
      const code = await cmd(['pendle', 'metadata'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        runRefreshSubtask: async () => ({
          ok: true,
          slice: { status: 'draft' },
          findings: [{ field: 'status', value: 'draft', source: 'prompt', confidence: 0.5 }],
          changes: [{ field: 'status', before: 'active', after: 'draft', reason: 'prompt default', confidence: 0.5 }],
          gaps: [],
        }),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 0);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.status, 'active');
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'refresh validation failure leaves canonical files unchanged',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/refresh.mjs')).default;
      const code = await cmd(['pendle', 'funding'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        runRefreshSubtask: async () => ({
          ok: true,
          slice: { fundingRounds: [{ bad: true }] },
          findings: [],
          changes: [],
          gaps: [],
        }),
        validate: async () => ({ ok: false, errors: ['bad funding round'] }),
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stderr: { write: () => {} },
      });
      assert.equal(code, 1);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.deepEqual(record.fundingRounds, [{ round: 'Seed', amount: '$1M' }]);
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
];
