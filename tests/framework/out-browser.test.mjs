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
        const pendleDir = join(dir, 'pendle');
        const aaveDir = join(dir, 'aave');
        await mkdir(pendleDir, { recursive: true });
        await mkdir(aaveDir, { recursive: true });
        await writeFile(join(pendleDir, 'record.json'), JSON.stringify({ slug: 'pendle' }));
        await writeFile(join(pendleDir, 'record.import.json'), JSON.stringify({ data: [{ slug: 'pendle' }] }));
        await writeFile(join(aaveDir, 'record.json'), JSON.stringify({ slug: 'aave' }));

        const idx = await collectOutIndex(dir);
        assert.equal(idx.protocols.length, 2);
        const slugs = idx.protocols.map((p) => p.slug);
        assert.deepEqual(slugs, ['aave', 'pendle']);
        const pendle = idx.protocols.find((p) => p.slug === 'pendle');
        assert.equal(pendle.recordPath, join(pendleDir, 'record.json'));
        assert.equal(pendle.dir, pendleDir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'collectOutIndex skips legacy run-id directories and .runs/',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-ob-'));
      try {
        await mkdir(join(dir, 'pendle'), { recursive: true });
        await writeFile(join(dir, 'pendle', 'record.json'), '{"name":"Pendle"}');
        // Legacy run-id directory — must be ignored:
        await mkdir(join(dir, '20260425T120000Z', 'pendle'), { recursive: true });
        await writeFile(join(dir, '20260425T120000Z', 'pendle', 'record.json'), '{"name":"old"}');
        // .runs/ scratch — must be ignored:
        await mkdir(join(dir, '.runs', 'R1'), { recursive: true });

        const idx = await collectOutIndex(dir);
        assert.equal(idx.protocols.length, 1);
        assert.equal(idx.protocols[0].slug, 'pendle');
        assert.equal(idx.protocols[0].recordPath, join(dir, 'pendle', 'record.json'));
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
        const pendleDir = join(dir, 'pendle');
        await mkdir(pendleDir, { recursive: true });
        await writeFile(join(pendleDir, 'record.json'), JSON.stringify({ slug: 'pendle', description: '</script>' }));
        await writeFile(join(pendleDir, 'record.import.json'), '{"version":"1.0","exportedAt":"2026-04-27T01:02:03.000Z","data":[{"slug":"pendle","locale":"en","description":"</script><div>"}]}');
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
