import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOutBrowser, collectOutIndex, hydrateView, startOutBrowserServer } from '../../framework/out-browser.mjs';

function embeddedData(html) {
  const raw = html.match(/<script id="out-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(raw, 'expected embedded out-data script');
  return JSON.parse(raw);
}

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
    name: 'buildOutBrowser writes escaped self-contained html',
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
        assert.doesNotMatch(html, /"content":"<\/script>/);
        assert.match(html, /\\u003c\/script>/);
        const script = html.match(/<script>\n([\s\S]*)<\/script>\n<\/body>/)?.[1];
        assert.ok(script, 'expected browser script');
        assert.ok(script.includes('(\\s*:)?'), 'expected generated JSON key whitespace regex escape');
        assert.ok(script.includes('\\b(?:true|false)\\b'), 'expected generated JSON boolean word-boundary regex escape');
        assert.ok(script.includes('-?\\d+'), 'expected generated JSON number regex escape');
        assert.equal(script.includes('\b'), false, 'generated browser script should not contain backspace escapes');
        new Function(script);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'hydrateView marks i18n stale when summary says translated but full artifact is missing',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-stale-i18n-'));
      try {
        const slugDir = join(dir, 'pendle');
        await mkdir(slugDir, { recursive: true });
        await writeFile(join(slugDir, 'record.json'), '{"slug":"pendle","members":[],"fundingRounds":[],"audits":{"items":[]}}');
        await writeFile(
          join(slugDir, 'summary.tsv'),
          'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\npendle\tOK\t0\t0\t0\tpass\tr1\tok\t1/1\n',
        );

        const view = await hydrateView(dir);
        const pendle = view.protocols.find((p) => p.slug === 'pendle');
        assert.equal(pendle.row.i18n, 'STALE');
        assert.equal(pendle.view.metrics.find((item) => item.key === 'i18n').value, 'STALE');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'collectOutIndex attaches per-slug git history',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-hist-'));
      try {
        await ensureRepo(dir);
        await mkdir(join(dir, 'pendle'), { recursive: true });
        await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}');
        await commit(dir, { paths: ['pendle/'], message: 'crawl(pendle): R1+R2 ok', runId: 'R1' });
        await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}');
        await commit(dir, { paths: ['pendle/'], message: 'set(pendle) v', runId: 'R2' });

        const idx = await collectOutIndex(dir);
        assert.equal(idx.protocols.length, 1);
        const hist = idx.protocols[0].history;
        assert.equal(hist.length, 2);
        assert.equal(hist[0].message, 'set(pendle) v');
        assert.equal(hist[1].message, 'crawl(pendle): R1+R2 ok');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'buildOutBrowser HTML lists protocols as primary nav, runs as filter',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-html-'));
      try {
        await ensureRepo(dir);
        await mkdir(join(dir, 'pendle'), { recursive: true });
        await writeFile(join(dir, 'pendle', 'record.json'), '{"name":"Pendle"}');
        await commit(dir, { paths: ['pendle/'], message: 'crawl(pendle): R1+R2 ok', runId: 'R1' });
        const { writeFile: wf } = await import('node:fs/promises');
        await wf(join(dir, '.runs.log'), '2026-04-27T10:00:00Z\tR1\tpendle\t1 OK / 0 fail\n');

        await buildOutBrowser(dir);
        const html = await readFile(join(dir, 'index.html'), 'utf8');
        const data = embeddedData(html);
        assert.match(html, /Protocols/i);
        assert.match(html, /pendle/);
        assert.match(html, /class="runs-filter-list"/);
        assert.match(html, /<option value="unknown">unknown<\/option>/);
        assert.deepEqual(data.facets.statuses, ['unknown']);
        // Run-id should appear in the filter section, not as a directory link.
        assert.match(html, /R1/);
        // The legacy "runs as primary nav" markers should be gone:
        assert.doesNotMatch(html, /class="runs-list"/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'buildOutBrowser embeds two-commit diff data per protocol',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-diff-'));
      try {
        await ensureRepo(dir);
        await mkdir(join(dir, 'pendle'), { recursive: true });
        await writeFile(join(dir, 'pendle', 'record.json'), '{"v":1}\n');
        await commit(dir, { paths: ['pendle/'], message: 'a', runId: 'A' });
        await writeFile(join(dir, 'pendle', 'record.json'), '{"v":2}\n');
        await commit(dir, { paths: ['pendle/'], message: 'b', runId: 'B' });

        await buildOutBrowser(dir);
        const html = await readFile(join(dir, 'index.html'), 'utf8');
        const data = embeddedData(html);
        // Expect the slug-scoped previous-version diff data to be present in some form:
        assert.match(html, /"v":1/);
        assert.match(html, /"v":2/);
        assert.deepEqual(data.protocols[0].view.diffSummary, { files: 1, additions: 1, deletions: 1 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'buildOutBrowser keeps unknown counts unknown for malformed records',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-html-bad-counts-'));
      try {
        const slugDir = join(dir, 'bad');
        await mkdir(slugDir, { recursive: true });
        await writeFile(join(slugDir, 'record.json'), '{bad json');
        await writeFile(
          join(slugDir, 'summary.tsv'),
          'slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\nbad\tSCHEMA_FAIL\t0\t0\t0\tfail\tr1\tdisabled\t-\n',
        );

        await buildOutBrowser(dir);
        const html = await readFile(join(dir, 'index.html'), 'utf8');
        const data = embeddedData(html);
        const bad = data.protocols.find((p) => p.slug === 'bad');
        assert.deepEqual(
          bad.view.metrics.slice(0, 3).map((item) => item.value),
          ['-', '-', '-'],
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'buildOutBrowser renders v2.1 workflow and logo asset panels',
    fn: async () => {
      const { ensureRepo, commit } = await import('../../framework/version-store.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'pi-html-logo-'));
      try {
        await ensureRepo(dir);
        await mkdir(join(dir, 'pendle'), { recursive: true });
        await mkdir(join(dir, 'protocol-logo'), { recursive: true });
        await mkdir(join(dir, 'protocol-member-logo'), { recursive: true });
        await mkdir(join(dir, 'audit-logo'), { recursive: true });
        await writeFile(join(dir, 'protocol-logo', 'pendle.png'), 'provider-logo');
        await writeFile(join(dir, 'protocol-member-logo', 'pendle-alice.png'), 'member-logo');
        await writeFile(join(dir, 'audit-logo', 'openzeppelin.png'), 'audit-logo');
        await writeFile(join(dir, 'pendle', 'record.json'), JSON.stringify({
          slug: 'pendle',
          provider: 'pendle',
          providerLogoUrl: 'https://uni.onekey-asset.com/static/logo/protocol-logo/pendle.png',
          displayName: 'Pendle',
          type: 'fixed_rate',
          fundingRounds: [],
          members: [
            {
              memberName: 'Alice',
              avatarUrl: 'https://uni.onekey-asset.com/static/logo/protocol-member-logo/pendle-alice.png',
            },
          ],
          audits: {
            items: [
              {
                auditor: 'OpenZeppelin',
                auditorLogoUrl: 'https://uni.onekey-asset.com/static/logo/audit-logo/openzeppelin.png',
              },
            ],
          },
        }));
        await commit(dir, { paths: ['pendle/', 'protocol-logo/', 'protocol-member-logo/', 'audit-logo/'], message: 'crawl(pendle): ok', runId: 'R1' });

        await buildOutBrowser(dir);
        const html = await readFile(join(dir, 'index.html'), 'utf8');
        const data = embeddedData(html);
        const pendle = data.protocols.find((p) => p.slug === 'pendle');
        assert.match(html, /Logo assets/);
        assert.match(html, /Workflow commands/);
        assert.match(html, /command-row/);
        assert.match(html, /asset-sections/);
        assert.match(html, /json-chip/);
        assert.match(html, /json-key/);
        assert.match(html, /diff-line\.add/);
        assert.match(html, /Copy minified JSON/);
        assert.match(html, /Copy diff/);
        assert.match(html, /data-detail-mode/);
        assert.match(html, /Artifacts/);
        assert.match(html, /Changes/);
        assert.match(html, /Assets/);
        assert.match(html, /Commands/);
        assert.match(html, /Search slug, provider, status/);
        assert.match(html, /protocol-logo\/pendle\.png/);
        assert.match(html, /protocol-member-logo\/pendle-alice\.png/);
        assert.match(html, /audit-logo\/openzeppelin\.png/);
        assert.equal(pendle.view.defaultArtifact, 'record.json');
        assert.equal(pendle.view.initials, 'P');
        assert.equal(pendle.view.modeCounts.assets, 3);
        assert.deepEqual(
          pendle.view.metrics.slice(0, 3).map((item) => item.value),
          ['1', '0', '1'],
        );
        assert.equal(pendle.view.facts.find((item) => item.label === 'Audits').value, '1');
        assert.equal(pendle.artifacts.find((item) => item.name === 'record.json').jsonMeta.shape, 'object(8)');
        assert.ok(pendle.view.searchText.includes('fixed_rate'));
        assert.ok(pendle.view.workflowCommands.some((item) => item.group === 'inspect'));
        assert.ok(pendle.view.workflowCommands.some((item) => item.group === 'version' && item.risk === 'destructive'));
        assert.ok(pendle.view.workflowCommands.some((item) => item.command.includes(`./run.sh diff pendle`)));
        assert.ok(pendle.view.workflowCommands.some((item) => item.command.includes(`'"Updated source-language description"'`)));
        const script = html.match(/<script>\n([\s\S]*)<\/script>\n<\/body>/)?.[1];
        assert.ok(script, 'expected browser script');
        new Function(script);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'live out browser server reads changed record.json without rebuilding index.html',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-live-browser-'));
      let server = null;
      try {
        const slugDir = join(dir, 'pendle');
        await mkdir(slugDir, { recursive: true });
        await writeFile(join(slugDir, 'record.json'), JSON.stringify({
          slug: 'pendle',
          displayName: 'Pendle',
          members: [],
          fundingRounds: [],
          audits: { items: [] },
        }));

        server = await startOutBrowserServer({
          outputRoot: dir,
          host: '127.0.0.1',
          port: 0,
          logger: { log: () => {} },
        });
        const { port } = server.address();
        const base = `http://127.0.0.1:${port}`;

        const html = await (await fetch(`${base}/`)).text();
        assert.match(html, /LIVE_DATA_URL = "\/api\/out-data"/);

        const before = await (await fetch(`${base}/api/out-data`)).json();
        const beforePendle = before.protocols.find((p) => p.slug === 'pendle');
        assert.equal(beforePendle.view.metrics.find((item) => item.key === 'members').value, '0');

        await writeFile(join(slugDir, 'record.json'), JSON.stringify({
          slug: 'pendle',
          displayName: 'Pendle',
          members: [{ memberName: 'Alice' }],
          fundingRounds: [],
          audits: { items: [] },
        }));

        const after = await (await fetch(`${base}/api/out-data`)).json();
        const afterPendle = after.protocols.find((p) => p.slug === 'pendle');
        assert.notEqual(after.revision, before.revision);
        assert.equal(afterPendle.view.metrics.find((item) => item.key === 'members').value, '1');
      } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
];
