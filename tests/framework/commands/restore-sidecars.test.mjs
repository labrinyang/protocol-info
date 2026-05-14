import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepo, commit } from '../../../framework/version-store.mjs';

const manifestPath = join(process.cwd(), 'consumers', 'protocol-info', 'manifest.json');

export const tests = [
  {
    name: 'restore-sidecars restores missing i18n sidecars from record.full.json',
    fn: async () => {
      const out = await mkdtemp(join(tmpdir(), 'pi-restore-sidecars-'));
      await ensureRepo(out);
      await mkdir(join(out, 'pendle'), { recursive: true });
      await writeFile(join(out, 'pendle', 'record.json'), '{"description":"AMM"}\n');
      await writeFile(join(out, 'pendle', 'record.full.json'), JSON.stringify({
        description: 'AMM',
        i18n: {
          zh_CN: { description: '自动做市商' },
          ja_JP: { description: 'AMM' },
        },
      }) + '\n');
      await commit(out, { paths: ['pendle/'], message: 'i18n(pendle): full', runId: 'R-full' });

      const stdout = [];
      const cmd = (await import('../../../framework/commands/restore-sidecars.mjs')).default;
      const code = await cmd(['pendle'], {
        outputRoot: out,
        manifestPath,
        stdout: { write: (s) => stdout.push(s) },
        stderr: { write: () => {} },
      });

      assert.equal(code, 0);
      assert.match(stdout.join(''), /2 sidecar\(s\) restored/);
      assert.equal(existsSync(join(out, 'pendle', '_debug', 'i18n', 'zh_CN.json')), true);
      const zh = JSON.parse(await readFile(join(out, 'pendle', '_debug', 'i18n', 'zh_CN.json'), 'utf8'));
      assert.equal(zh.description, '自动做市商');
    },
  },
];
