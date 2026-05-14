import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureRepo, commit, isClean, log } from '../../../framework/version-store.mjs';

async function seedOut() {
  const out = await mkdtemp(join(tmpdir(), 'pi-analyze-cmd-'));
  await ensureRepo(out);
  await mkdir(join(out, 'pendle'), { recursive: true });
  await writeFile(join(out, 'pendle', 'record.json'), JSON.stringify({
    name: 'Pendle',
    description: 'old',
    status: 'draft',
    members: [],
  }) + '\n');
  await writeFile(join(out, 'pendle', 'findings.json'), JSON.stringify([
    { field: 'description', value: 'old', source: 'https://example.com/old', confidence: 0.8 },
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

function proposal(overrides = {}) {
  return {
    ok: true,
    path: 'description',
    proposed_value: 'new',
    reason: 'verified',
    confidence: 0.9,
    findings: [{ field: 'description', value: 'new', source: 'https://example.com/new', confidence: 0.9 }],
    changes: [{ field: 'description', before: 'old', after: 'new', reason: 'verified', confidence: 0.9 }],
    gaps: [],
    ...overrides,
  };
}

export const tests = [
  {
    name: 'analyze proposal-only prints proposal and writes nothing',
    fn: async () => {
      const out = await seedOut();
      let stdout = '';
      const cmd = (await import('../../../framework/commands/analyze.mjs')).default;
      const code = await cmd(['pendle', 'description', '--query', 'verify it'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        analyzeKey: async ({ slug, jsonpath, query, currentValue }) => {
          assert.equal(slug, 'pendle');
          assert.equal(jsonpath, 'description');
          assert.equal(query, 'verify it');
          assert.equal(currentValue, 'old');
          return proposal();
        },
        validate: async () => {
          throw new Error('validate should not run');
        },
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).proposed_value, 'new');
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'old');
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'analyze --apply writes proposed field, appends sidecars, and commits',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/analyze.mjs')).default;
      const code = await cmd(['pendle', 'description', '--query', 'verify it', '--apply'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        analyzeKey: async () => proposal(),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'new');
      const findings = JSON.parse(await readFile(join(out, 'pendle', 'findings.json'), 'utf8'));
      assert.equal(findings.length, 2);
      assert.equal(findings.at(-1).value, 'new');
      const changes = JSON.parse(await readFile(join(out, 'pendle', 'changes.json'), 'utf8'));
      assert.equal(changes.at(-1).field, 'description');
      const hist = await log(out, { slug: 'pendle' });
      assert.equal(hist[0].message, 'analyze(pendle) description');
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'analyze --apply invalidates i18n only when the applied path is translatable',
    fn: async () => {
      const out = await seedOut();
      await addI18nArtifacts(out);
      const cmd = (await import('../../../framework/commands/analyze.mjs')).default;
      const code = await cmd(['pendle', 'status', '--query', 'promote', '--apply'], {
        outputRoot: out,
        manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
        analyzeKey: async () => proposal({ path: 'status', proposed_value: 'active' }),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'zh_CN.json')), true);
          assert.equal(existsSync(join(slugDir, 'record.full.json')), true);
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      assert.equal(existsSync(join(out, 'pendle', '_debug', 'i18n', 'zh_CN.json')), true);
      assert.equal(existsSync(join(out, 'pendle', 'record.full.json')), true);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.status, 'active');
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'analyze --apply invalidates i18n when the applied path is translatable',
    fn: async () => {
      const out = await seedOut();
      await addI18nArtifacts(out);
      const cmd = (await import('../../../framework/commands/analyze.mjs')).default;
      const code = await cmd(['pendle', 'description', '--query', 'verify it', '--apply'], {
        outputRoot: out,
        manifestPath: join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json'),
        analyzeKey: async () => proposal(),
        validate: async () => ({ ok: true, errors: [] }),
        runPostProcessing: async ({ slugDir }) => {
          assert.equal(existsSync(join(slugDir, '_debug', 'i18n', 'zh_CN.json')), false);
          assert.equal(existsSync(join(slugDir, 'record.full.json')), false);
          await writeFile(join(slugDir, 'record.import.json'), '{"ok":true}\n');
          return 0;
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      assert.equal(existsSync(join(out, 'pendle', 'record.full.json')), false);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'analyze --apply validation failure leaves canonical files unchanged',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/analyze.mjs')).default;
      const code = await cmd(['pendle', 'description', '--query', 'verify it', '--apply'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        analyzeKey: async () => proposal({ proposed_value: 42 }),
        validate: async () => ({ ok: false, errors: ['description must be string'] }),
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });

      assert.equal(code, 1);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'old');
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
  {
    name: 'analyze --apply rejects proposal for a different path',
    fn: async () => {
      const out = await seedOut();
      const cmd = (await import('../../../framework/commands/analyze.mjs')).default;
      const code = await cmd(['pendle', 'description', '--query', 'verify it', '--apply'], {
        outputRoot: out,
        manifestPath: 'manifest.json',
        analyzeKey: async () => proposal({ path: 'name', proposed_value: 'Bad' }),
        validate: async () => {
          throw new Error('validate should not run');
        },
        runPostProcessing: async () => {
          throw new Error('post should not run');
        },
        commitAndRebuild: commitOnly,
        normalizeEnvelope: normalizeNoop,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });

      assert.equal(code, 1);
      const record = JSON.parse(await readFile(join(out, 'pendle', 'record.json'), 'utf8'));
      assert.equal(record.description, 'old');
      assert.equal(record.name, 'Pendle');
      assert.equal((await log(out, { slug: 'pendle' })).length, 1);
      assert.equal(await isClean(out, { slug: 'pendle' }), true);
    },
  },
];
