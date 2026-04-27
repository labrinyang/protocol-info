import { strict as assert } from 'node:assert';
import { dispatchWorkflowCommand, parseArgv } from '../../framework/cli.mjs';

export const tests = [
  {
    name: 'dispatchWorkflowCommand routes known workflow command',
    fn: async () => {
      const calls = [];
      const code = await dispatchWorkflowCommand(['get', 'pendle', 'name'], {
        commandMap: {
          get: async () => ({
            default: async (args, ctx) => {
              calls.push({ args, ctx });
              return 0;
            },
          }),
        },
        context: { outputRoot: '/tmp/out' },
      });
      assert.equal(code, 0);
      assert.deepEqual(calls[0].args, ['pendle', 'name']);
      assert.equal(calls[0].ctx.outputRoot, '/tmp/out');
    },
  },
  {
    name: 'dispatchWorkflowCommand returns null for crawl-style argv',
    fn: async () => {
      const code = await dispatchWorkflowCommand(['--display-name', 'Pendle'], { commandMap: {} });
      assert.equal(code, null);
    },
  },
  {
    name: 'dispatchWorkflowCommand parses workflow flags before and after the command',
    fn: async () => {
      const calls = [];
      const commandMap = {
        set: async () => ({
          default: async (args, ctx) => {
            calls.push({ args, ctx });
            return 0;
          },
        }),
      };
      const code = await dispatchWorkflowCommand([
        '--manifest', '/tmp/manifest.json',
        'set', 'pendle', 'description', '"new"',
        '--force-overwrite',
      ], { commandMap });
      assert.equal(code, 0);
      assert.deepEqual(calls[0].args, ['pendle', 'description', '"new"']);
      assert.equal(calls[0].ctx.manifestPath, '/tmp/manifest.json');
      assert.equal(calls[0].ctx.forceOverwrite, true);
    },
  },
  {
    name: 'dispatchWorkflowCommand still returns null for crawl argv with global-looking flags',
    fn: async () => {
      const code = await dispatchWorkflowCommand(['--model', 'sonnet', '--display-name', 'Pendle']);
      assert.equal(code, null);
    },
  },
  {
    name: 'parseArgv still handles crawl flags',
    fn: async () => {
      const parsed = parseArgv(['--display-name', 'Pendle', '--type', 'fixed_rate']);
      assert.equal(parsed.providers[0].slug, 'pendle');
      assert.equal(parsed.providers[0].type, 'fixed_rate');
    },
  },
];
