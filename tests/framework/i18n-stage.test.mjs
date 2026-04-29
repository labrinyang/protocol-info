import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTranslatable, mergeTranslated, runI18nStage } from '../../framework/i18n-stage.mjs';

export const tests = [
  {
    name: 'extractTranslatable picks scalar field',
    fn: async () => {
      const out = extractTranslatable({ description: 'hello', x: 1 }, ['description']);
      assert.deepEqual(out, { description: 'hello' });
    },
  },
  {
    name: 'extractTranslatable picks fields under array index wildcard',
    fn: async () => {
      const out = extractTranslatable(
        { members: [{ memberPosition: 'CEO', oneLiner: 'a', skip: 'x' }, { memberPosition: 'CTO', oneLiner: 'b', skip: 'y' }] },
        ['members[].memberPosition', 'members[].oneLiner']
      );
      assert.deepEqual(out, {
        members: [
          { memberPosition: 'CEO', oneLiner: 'a' },
          { memberPosition: 'CTO', oneLiner: 'b' },
        ],
      });
    },
  },
  {
    name: 'mergeTranslated merges back into a base record',
    fn: async () => {
      const base = { slug: 's', description: 'EN', members: [{ memberName: 'A', memberPosition: 'EN_POS', oneLiner: 'EN_OL' }] };
      const tr = { description: 'ZH', members: [{ memberPosition: 'ZH_POS', oneLiner: 'ZH_OL' }] };
      const out = mergeTranslated(base, tr);
      assert.equal(out.description, 'ZH');
      assert.equal(out.members[0].memberName, 'A');
      assert.equal(out.members[0].memberPosition, 'ZH_POS');
      assert.equal(out.members[0].oneLiner, 'ZH_OL');
    },
  },
  {
    name: 'runI18nStage can route translations through OpenAI-compatible provider',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-i18n-openai-'));
      const systemPrompt = join(dir, 'system.md');
      const userPrompt = join(dir, 'user.md');
      const schemaPath = join(dir, 'schema.json');
      const outputDir = join(dir, 'out');
      await writeFile(systemPrompt, 'Translate precisely.');
      await writeFile(userPrompt, 'Locale {{LOCALE_CODE}} {{LOCALE_NAME}}\n{{SOURCE_JSON}}');
      await writeFile(schemaPath, JSON.stringify({
        type: 'object',
        additionalProperties: false,
        required: ['description', 'members'],
        properties: {
          description: { type: 'string' },
          members: { type: 'array' },
        },
      }));

      let called = false;
      const result = await runI18nStage({
        manifest: {
          i18n: {
            enabled: true,
            translatable_fields: ['description', 'members[].oneLiner'],
            locale_catalog: [{ code: 'zh_CN', name_en: 'Simplified Chinese' }],
            openai_model_default: 'gpt-test',
          },
          _abs: {
            i18n: {
              system_prompt_abs: systemPrompt,
              user_prompt_abs: userPrompt,
              schema_abs: schemaPath,
            },
          },
        },
        record: {
          description: 'A fixed-rate protocol.',
          members: [{ memberName: 'Alice', oneLiner: 'Builds fixed-rate markets.' }],
        },
        selectedLocales: ['zh_CN'],
        outputDir,
        provider: 'openai',
        modelOverride: 'gpt-test',
        runOpenAI: async ({ model, userPrompt: renderedPrompt }) => {
          called = true;
          assert.equal(model, 'gpt-test');
          assert.match(renderedPrompt, /zh_CN/);
          assert.match(renderedPrompt, /A fixed-rate protocol/);
          return {
            structured_output: {
              description: '固定利率协议。',
              members: [{ oneLiner: '构建固定利率市场。' }],
            },
            total_cost_usd: 0,
            num_turns: 1,
            provider: 'openai',
            model,
          };
        },
      });

      assert.equal(called, true);
      assert.equal(result.ok, 1);
      assert.deepEqual(result.failed, []);
      const sidecar = JSON.parse(await readFile(join(outputDir, 'zh_CN.json'), 'utf8'));
      assert.equal(sidecar.description, '固定利率协议。');
      const envelope = JSON.parse(await readFile(join(outputDir, 'zh_CN.envelope.json'), 'utf8'));
      assert.equal(envelope.provider, 'openai');
    },
  },
  {
    name: 'runI18nStage allows OpenAI-compatible budget when pricing is configured',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-i18n-openai-priced-budget-'));
      const systemPrompt = join(dir, 'system.md');
      const userPrompt = join(dir, 'user.md');
      const schemaPath = join(dir, 'schema.json');
      await writeFile(systemPrompt, 'Translate.');
      await writeFile(userPrompt, '{{SOURCE_JSON}}');
      await writeFile(schemaPath, JSON.stringify({ type: 'object' }));

      let call = null;
      const result = await runI18nStage({
        manifest: {
          i18n: {
            enabled: true,
            translatable_fields: ['description'],
            locale_catalog: [{ code: 'zh_CN', name_en: 'Simplified Chinese' }],
          },
          _abs: {
            i18n: {
              system_prompt_abs: systemPrompt,
              user_prompt_abs: userPrompt,
              schema_abs: schemaPath,
            },
          },
        },
        record: { description: 'hello' },
        selectedLocales: ['zh_CN'],
        outputDir: join(dir, 'out'),
        provider: 'openai',
        budgetCap: 0.1,
        env: {
          OPENAI_BASE_URL: 'https://llm.example/v1',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'gpt-test',
          OPENAI_INPUT_COST_PER_1M: '2',
          OPENAI_OUTPUT_COST_PER_1M: '8',
        },
        runOpenAI: async (args) => {
          call = args;
          return {
            structured_output: { description: '你好' },
            total_cost_usd: 0.001,
            num_turns: 1,
            provider: 'openai',
            model: args.model,
          };
        },
      });

      assert.equal(result.ok, 1);
      assert.equal(call.maxBudgetUsd, 0.1);
      assert.deepEqual(call.pricing, { inputCostPer1M: 2, outputCostPer1M: 8 });
    },
  },
  {
    name: 'runI18nStage rejects OpenAI-compatible provider when USD cap is requested',
    fn: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-i18n-openai-budget-'));
      const systemPrompt = join(dir, 'system.md');
      const userPrompt = join(dir, 'user.md');
      const schemaPath = join(dir, 'schema.json');
      await writeFile(systemPrompt, 'Translate.');
      await writeFile(userPrompt, '{{SOURCE_JSON}}');
      await writeFile(schemaPath, JSON.stringify({ type: 'object' }));

      await assert.rejects(
        () => runI18nStage({
          manifest: {
            i18n: {
              enabled: true,
              translatable_fields: ['description'],
              locale_catalog: [{ code: 'zh_CN', name_en: 'Simplified Chinese' }],
            },
            _abs: {
              i18n: {
                system_prompt_abs: systemPrompt,
                user_prompt_abs: userPrompt,
                schema_abs: schemaPath,
              },
            },
          },
          record: { description: 'hello' },
          selectedLocales: ['zh_CN'],
          outputDir: join(dir, 'out'),
          provider: 'openai',
          budgetCap: 0.1,
          runOpenAI: async () => {
            throw new Error('openai should not run');
          },
        }),
        (err) => err.kind === 'budget_unknown' && /cannot honor USD budget caps/.test(err.message),
      );
    },
  },
];
