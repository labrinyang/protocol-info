import { strict as assert } from 'node:assert';
import { defaultOutputRoot, dispatchWorkflowCommand, parseArgv } from '../../framework/cli.mjs';

const OPENAI_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_INPUT_COST_PER_1M',
  'OPENAI_OUTPUT_COST_PER_1M',
  'PROTOCOL_INFO_ENV_ORIGIN_OPENAI_API_KEY',
  'PROTOCOL_INFO_ENV_ORIGIN_OPENAI_BASE_URL',
  'PROTOCOL_INFO_ENV_ORIGIN_OPENAI_MODEL',
  'PROTOCOL_INFO_ENV_ORIGIN_OPENAI_INPUT_COST_PER_1M',
  'PROTOCOL_INFO_ENV_ORIGIN_OPENAI_OUTPUT_COST_PER_1M',
];
const UNAVATAR_ENV_KEYS = [
  'UNAVATAR_API_KEY',
  'PROTOCOL_INFO_ENV_ORIGIN_UNAVATAR_API_KEY',
];
const ROOTDATA_ENV_KEYS = [
  'ROOTDATA_API_KEY',
  'ROOTDATA_API_KEYS',
  'ROOTDATA_API_KEY_1',
  'ROOTDATA_API_KEY_2',
  'PROTOCOL_INFO_ENV_ORIGIN_ROOTDATA_API_KEY',
  'PROTOCOL_INFO_ENV_ORIGIN_ROOTDATA_API_KEYS',
  'PROTOCOL_INFO_ENV_ORIGIN_ROOTDATA_API_KEY_1',
  'PROTOCOL_INFO_ENV_ORIGIN_ROOTDATA_API_KEY_2',
];

async function withEnvRestored(keys, fn) {
  const snapshot = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

export const tests = [
  {
    name: 'importing cli.mjs does not autoload user .env',
    fn: async () => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { spawn } = await import('node:child_process');
      const home = await mkdtemp(join(tmpdir(), 'pi-cli-env-'));
      const configDir = join(home, '.config', 'protocol-info');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, '.env'), [
        'I18N_PROVIDER=openai',
        'OPENAI_API_KEY=secret',
        'OPENAI_BASE_URL=https://llm.example/v1',
        'OPENAI_MODEL=gpt-test',
        'ROOTDATA_API_KEYS=root-secret-a,root-secret-b',
        'UNAVATAR_API_KEY=unavatar-secret',
        '',
      ].join('\n'));
      const env = { ...process.env, HOME: home };
      delete env.I18N_PROVIDER;
      delete env.OPENAI_API_KEY;
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_MODEL;
      for (const key of ROOTDATA_ENV_KEYS) delete env[key];
      delete env.UNAVATAR_API_KEY;
      const cliUrl = pathToFileURL(join(process.cwd(), 'framework', 'cli.mjs')).href;
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(cliUrl)}); console.log([process.env.I18N_PROVIDER || '', process.env.OPENAI_API_KEY || '', process.env.OPENAI_BASE_URL || '', process.env.OPENAI_MODEL || '', process.env.ROOTDATA_API_KEY || '', process.env.ROOTDATA_API_KEYS || '', process.env.UNAVATAR_API_KEY || ''].join('|'));`,
        ], { env });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.stderr.on('data', (chunk) => { err += chunk.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve(out.trim());
          else reject(new Error(err || `node exited ${code}`));
        });
      });
      assert.equal(stdout, '||||||');
    },
  },
  {
    name: 'loadRuntimeEnv loads OpenAI-compatible config from the same .env candidates as RootData',
    fn: async () => {
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { spawn } = await import('node:child_process');
      const dir = await mkdtemp(join(tmpdir(), 'pi-cli-env-load-'));
      const envFile = join(dir, '.env');
      await writeFile(envFile, [
        'ROOTDATA_API_KEY_1=root-secret-a',
        'ROOTDATA_API_KEY_2=root-secret-b',
        'OPENAI_API_KEY=openai-secret',
        'OPENAI_BASE_URL=https://llm.example/v1',
        'OPENAI_MODEL=gpt-test',
        'UNAVATAR_API_KEY=unavatar-secret',
        'OPENAI_INPUT_COST_PER_1M=2',
        'OPENAI_OUTPUT_COST_PER_1M=8',
        '',
      ].join('\n'));
      const cliUrl = pathToFileURL(join(process.cwd(), 'framework', 'cli.mjs')).href;
      const stdout = await new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const key of [...ROOTDATA_ENV_KEYS, ...OPENAI_ENV_KEYS, ...UNAVATAR_ENV_KEYS]) delete env[key];
        const child = spawn(process.execPath, [
          '--input-type=module',
          '-e',
          [
            `import { loadRuntimeEnv, parseArgv } from ${JSON.stringify(cliUrl)};`,
            `loadRuntimeEnv([${JSON.stringify(envFile)}]);`,
            `const parsed = parseArgv(['--display-name','Pendle']);`,
            `console.log(JSON.stringify({`,
            `root: parsed.options.rootdataKeyOrigin,`,
            `rootKey: process.env.ROOTDATA_API_KEY,`,
            `rootKeys: process.env.ROOTDATA_API_KEYS || '',`,
            `api: parsed.options.openAIOrigins.apiKey,`,
            `base: parsed.options.openAIOrigins.baseUrl,`,
            `model: parsed.options.openAIOrigins.model,`,
            `input: parsed.options.openAIOrigins.inputCost,`,
            `output: parsed.options.openAIOrigins.outputCost,`,
            `baseUrl: process.env.OPENAI_BASE_URL,`,
            `unavatar: parsed.options.unavatarKeyOrigin,`,
            `}));`,
          ].join('\n'),
        ], { env });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.stderr.on('data', (chunk) => { err += chunk.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve(out.trim());
          else reject(new Error(err || `node exited ${code}`));
        });
      });
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.root, envFile);
      assert.equal(parsed.rootKey, 'root-secret-a');
      assert.equal(parsed.rootKeys, '');
      assert.equal(parsed.api, envFile);
      assert.equal(parsed.base, envFile);
      assert.equal(parsed.model, envFile);
      assert.equal(parsed.input, envFile);
      assert.equal(parsed.output, envFile);
      assert.equal(parsed.baseUrl, 'https://llm.example/v1');
      assert.equal(parsed.unavatar, envFile);
    },
  },
  {
    name: 'stale origin markers do not count as configured secrets',
    fn: async () => {
      const { join } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { spawn } = await import('node:child_process');
      const cliUrl = pathToFileURL(join(process.cwd(), 'framework', 'cli.mjs')).href;
      const stdout = await new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const key of ROOTDATA_ENV_KEYS) delete env[key];
        delete env.OPENAI_API_KEY;
        env.PROTOCOL_INFO_ENV_ORIGIN_ROOTDATA_API_KEY = '/tmp/stale-rootdata.env';
        env.PROTOCOL_INFO_ENV_ORIGIN_OPENAI_API_KEY = '/tmp/stale-openai.env';
        const child = spawn(process.execPath, [
          '--input-type=module',
          '-e',
          [
            `import { parseArgv } from ${JSON.stringify(cliUrl)};`,
            `const parsed = parseArgv(['--display-name','Pendle']);`,
            `console.log(JSON.stringify({`,
            `root: parsed.options.rootdataKeyOrigin,`,
            `api: parsed.options.openAIOrigins.apiKey`,
            `}));`,
          ].join('\n'),
        ], { env });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.stderr.on('data', (chunk) => { err += chunk.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve(out.trim());
          else reject(new Error(err || `node exited ${code}`));
        });
      });
      assert.deepEqual(JSON.parse(stdout), { root: null, api: null });
    },
  },
  {
    name: 'startup banner treats audit-report LLM provider as OpenAI-compatible route',
    fn: async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { spawn } = await import('node:child_process');
      const home = await mkdtemp(join(tmpdir(), 'pi-cli-home-'));
      const stdout = await new Promise((resolve, reject) => {
        const env = { ...process.env, HOME: home, AUDIT_REPORTS_LLM_PROVIDER: 'openai' };
        for (const key of [...ROOTDATA_ENV_KEYS, ...OPENAI_ENV_KEYS, ...UNAVATAR_ENV_KEYS]) delete env[key];
        const child = spawn(process.execPath, [
          'framework/cli.mjs',
          '--dry-run',
          '--display-name',
          'Pendle',
        ], { cwd: process.cwd(), env });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.stderr.on('data', (chunk) => { err += chunk.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(err || `node exited ${code}`));
        });
      });
      assert.match(stdout, /External LLM:\s+requested but missing OPENAI_API_KEY/);
    },
  },
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
    name: 'dispatchWorkflowCommand defaults outputRoot to the caller current directory',
    fn: async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const originalCwd = process.cwd();
      const cwd = await mkdtemp(join(tmpdir(), 'pi-cli-cwd-out-'));
      const calls = [];
      try {
        process.chdir(cwd);
        const code = await dispatchWorkflowCommand(['get', 'pendle', 'name'], {
          commandMap: {
            get: async () => ({
              default: async (args, ctx) => {
                calls.push({ args, ctx });
                return 0;
              },
            }),
          },
        });
        assert.equal(code, 0);
        assert.equal(calls[0].ctx.outputRoot, join(process.cwd(), 'out'));
      } finally {
        process.chdir(originalCwd);
      }
    },
  },
  {
    name: 'defaultOutputRoot resolves to cwd/out',
    fn: async () => {
      const { join } = await import('node:path');
      assert.equal(defaultOutputRoot('/tmp/protocol-work'), join('/tmp/protocol-work', 'out'));
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
    fn: async () => await withEnvRestored([...ROOTDATA_ENV_KEYS, ...OPENAI_ENV_KEYS, ...UNAVATAR_ENV_KEYS], async () => {
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
        '--openai-api-key', 'test-openai-key',
        '--unavatar-key', 'test-unavatar-key',
        'set', 'pendle', 'description', '"new"',
        '--force-overwrite',
        '--openai-base-url', 'https://llm.example/v1',
        '--openai-model', 'gpt-test',
        '--openai-input-cost-per-1m', '2',
        '--openai-output-cost-per-1m', '8',
      ], { commandMap });
      assert.equal(code, 0);
      assert.deepEqual(calls[0].args, ['pendle', 'description', '"new"']);
      assert.equal(calls[0].ctx.manifestPath, '/tmp/manifest.json');
      assert.equal(calls[0].ctx.forceOverwrite, true);
      assert.equal(process.env.OPENAI_API_KEY, 'test-openai-key');
      assert.equal(process.env.UNAVATAR_API_KEY, 'test-unavatar-key');
      assert.equal(process.env.OPENAI_BASE_URL, 'https://llm.example/v1');
      assert.equal(process.env.OPENAI_MODEL, 'gpt-test');
      assert.equal(process.env.OPENAI_INPUT_COST_PER_1M, '2');
      assert.equal(process.env.OPENAI_OUTPUT_COST_PER_1M, '8');
    }),
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
      const parsed = parseArgv(['--r2-routing', 'external_first_with_claude_fallback', '--display-name', 'Pendle']);
      assert.equal(parsed.providers[0].slug, 'pendle');
      assert.equal(Object.hasOwn(parsed.providers[0], 'type'), false);
      assert.equal(parsed.options.r2Routing, 'external_first_with_claude_fallback');
    },
  },
  {
    name: 'parseArgv rejects --type because type is inferred from evidence',
    fn: async () => {
      assert.throws(
        () => parseArgv(['--display-name', 'Pendle', '--type', 'fixed_rate']),
        /--type 不再是 CLI 输入字段/
      );
    },
  },
  {
    name: 'parseArgv accepts one-shot OpenAI-compatible config flags',
    fn: async () => await withEnvRestored([...OPENAI_ENV_KEYS, ...UNAVATAR_ENV_KEYS], async () => {
      const parsed = parseArgv([
        '--openai-api-key', 'test-openai-key',
        '--unavatar-key', 'test-unavatar-key',
        '--openai-base-url', 'https://llm.example/v1',
        '--openai-model', 'gpt-test',
        '--openai-input-cost-per-1m', '2',
        '--openai-output-cost-per-1m', '8',
        '--display-name', 'Pendle',
      ]);
      assert.equal(process.env.OPENAI_API_KEY, 'test-openai-key');
      assert.equal(process.env.UNAVATAR_API_KEY, 'test-unavatar-key');
      assert.equal(process.env.OPENAI_BASE_URL, 'https://llm.example/v1');
      assert.equal(process.env.OPENAI_MODEL, 'gpt-test');
      assert.equal(parsed.options.openAIOrigins.apiKey, '--openai-api-key');
      assert.equal(parsed.options.openAIOrigins.baseUrl, '--openai-base-url');
      assert.equal(parsed.options.openAIOrigins.model, '--openai-model');
      assert.equal(parsed.options.openAIOrigins.inputCost, '--openai-input-cost-per-1m');
      assert.equal(parsed.options.openAIOrigins.outputCost, '--openai-output-cost-per-1m');
      assert.equal(parsed.options.unavatarKeyOrigin, '--unavatar-key');
    }),
  },
];
