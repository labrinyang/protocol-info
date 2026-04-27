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
        const runDir = join(dir, '_runs', runId);
        await mkdir(slugDir, { recursive: true });
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, 'summary.tsv'), 'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\npendle\tOK\t2\t1\t3\tpass\tr2\tok\t-\n');
        await writeFile(join(slugDir, 'summary.tsv'), 'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\npendle\tOK\t2\t1\t3\tpass\tr2\tok\t-\n');
        await writeFile(join(slugDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'pendle' }] }));
        await writeFile(join(slugDir, 'record.json'), JSON.stringify({ slug: 'pendle', description: '</script>' }));

        const index = await collectOutIndex(dir);
        assert.equal(index.runs.length, 1);
        assert.equal(index.runs[0].protocols[0].slug, 'pendle');
        assert.equal(index.runs[0].protocols[0].row.status, 'OK');
        assert.ok(index.runs[0].protocols[0].artifacts.some((a) => a.name === 'record.import.json'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'buildOutBrowser writes escaped self-contained html',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'out-browser-'));
      try {
        const runId = '20260427T010203Z';
        const slugDir = join(dir, 'pendle', runId);
        await mkdir(slugDir, { recursive: true });
        await writeFile(join(slugDir, 'record.import.json'), '{"html":"</script><div>"}');
        const file = await buildOutBrowser(dir);
        const html = await readFile(file, 'utf8');
        assert.match(html, /protocol-info out/);
        assert.doesNotMatch(html, /"content":"<\/script>/);
        assert.match(html, /\\u003c\/script>/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
];
