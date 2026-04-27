import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOutBrowser, collectOutIndex } from '../../framework/out-browser.mjs';

export const tests = [
  {
    name: 'collectOutIndex discovers protocol-first artifacts',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'out-browser-'));
      try {
        const runId = '20260427T010203Z';
        const slugDir = join(dir, 'pendle', runId);
        const legacyRunId = '20260426T010203Z';
        const legacySlugDir = join(dir, legacyRunId, 'aave');
        const runDir = join(dir, '_runs', runId);
        await mkdir(slugDir, { recursive: true });
        await mkdir(legacySlugDir, { recursive: true });
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, 'summary.tsv'), 'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\npendle\tOK\t2\t1\t3\tpass\tr2\tok\t-\n');
        await writeFile(join(slugDir, 'summary.tsv'), 'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\npendle\tOK\t2\t1\t3\tpass\tr2\tok\t-\n');
        await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'pendle' }] }));
        await writeFile(join(slugDir, 'record.json'), JSON.stringify({ slug: 'pendle', description: '</script>' }));
        await writeFile(join(legacySlugDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'aave' }] }));

        const index = await collectOutIndex(dir);
        assert.equal(index.runs.length, 2);
        const current = index.runs.find((run) => run.runId === runId);
        const legacy = index.runs.find((run) => run.runId === legacyRunId);
        assert.equal(current.protocols[0].slug, 'pendle');
        assert.equal(current.protocols[0].row.status, 'OK');
        assert.ok(current.protocols[0].artifacts.some((a) => a.name === 'record.import.json'));
        assert.equal(legacy.protocols[0].slug, 'aave');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'buildOutBrowser writes escaped self-contained html with compare tools',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'out-browser-'));
      try {
        const runId = '20260427T010203Z';
        const previousRunId = '20260426T010203Z';
        const slugDir = join(dir, 'pendle', runId);
        const previousSlugDir = join(dir, 'pendle', previousRunId);
        await mkdir(slugDir, { recursive: true });
        await mkdir(previousSlugDir, { recursive: true });
        await writeFile(join(slugDir, 'record.import.json'), '{"version":"1.0","exportedAt":"2026-04-27T01:02:03.000Z","data":[{"slug":"pendle","locale":"en","description":"</script><div>"}]}');
        await writeFile(join(previousSlugDir, 'record.import.json'), '{"version":"1.0","exportedAt":"2026-04-26T01:02:03.000Z","data":[{"slug":"pendle","locale":"en","description":"old"}]}');
        const file = await buildOutBrowser(dir);
        const html = await readFile(file, 'utf8');
        assert.match(html, /protocol-info out/);
        assert.match(html, /Compare runs/);
        assert.match(html, /Copy diff/);
        assert.match(html, /diffArtifacts/);
        assert.doesNotMatch(html, /"content":"<\/script>/);
        assert.match(html, /\\u003c\/script>/);
        const script = html.match(/<script>\n([\s\S]*)<\/script>\n<\/body>/)?.[1];
        assert.ok(script, 'expected browser script');
        new Function(script);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
];
