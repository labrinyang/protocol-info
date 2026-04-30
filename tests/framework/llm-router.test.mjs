import { strict as assert } from 'node:assert';
import {
  assertProviderAllowed,
  resolveLLMProvider,
  resolveLLMTimeoutMs,
  resolveOpenAIPricing,
  resolveOpenAIModel,
  runStructuredLLM,
} from '../../framework/llm-router.mjs';

export const tests = [
  {
    name: 'resolveLLMProvider uses stage-specific env before fallback',
    fn: async () => {
      assert.equal(resolveLLMProvider({ stage: 'r2', env: { R2_LLM_PROVIDER: 'openai' } }), 'openai');
      assert.equal(resolveLLMProvider({ stage: 'refresh:audits', env: { REFRESH_AUDITS_LLM_PROVIDER: 'openai' } }), 'openai');
      assert.equal(resolveLLMProvider({ stage: 'refresh:audits', env: { REFRESH_LLM_PROVIDER: 'openai' } }), 'openai');
      assert.equal(resolveLLMProvider({ stage: 'r1', env: {} }), 'claude');
    },
  },
  {
    name: 'resolveOpenAIModel ignores claude model names',
    fn: async () => {
      assert.equal(
        resolveOpenAIModel({ stage: 'r2', model: 'claude-sonnet-4-6', env: { R2_OPENAI_MODEL: 'gpt-stage', OPENAI_MODEL: 'gpt-global' } }),
        'gpt-stage'
      );
      assert.equal(resolveOpenAIModel({ stage: 'r2', model: 'gpt-cli', env: { OPENAI_MODEL: 'gpt-global' } }), 'gpt-cli');
    },
  },
  {
    name: 'stage policy blocks OpenAI-compatible provider for web-required R1',
    fn: async () => {
      await assert.rejects(
        () => runStructuredLLM({
          stage: 'r1',
          env: {
            R1_LLM_PROVIDER: 'openai',
            OPENAI_API_KEY: 'test-key',
            OPENAI_MODEL: 'gpt-test',
          },
          userPrompt: 'prompt',
          schemaJson: { type: 'object' },
          runOpenAIImpl: async () => {
            throw new Error('openai should not run');
          },
        }),
        (err) => err.kind === 'provider_not_allowed',
      );
    },
  },
  {
    name: 'manifest policy can explicitly allow a refresh subtask provider',
    fn: async () => {
      assert.doesNotThrow(() => assertProviderAllowed({
        stage: 'refresh:team',
        provider: 'openai',
        manifest: {
          llm: {
            stages: {
              'refresh:team': {
                allowed_providers: ['claude', 'openai'],
                required_capabilities: ['structured_json'],
              },
            },
          },
        },
      }));
    },
  },
  {
    name: 'resolveOpenAIPricing uses stage-specific env before global env',
    fn: async () => {
      assert.deepEqual(resolveOpenAIPricing({
        stage: 'r2',
        env: {
          OPENAI_INPUT_COST_PER_1M: '100',
          OPENAI_OUTPUT_COST_PER_1M: '100',
          R2_OPENAI_INPUT_COST_PER_1M: '2',
          R2_OPENAI_OUTPUT_COST_PER_1M: '8',
        },
      }), { inputCostPer1M: 2, outputCostPer1M: 8 });
    },
  },
  {
    name: 'resolveLLMTimeoutMs uses provider and stage specific env',
    fn: async () => {
      assert.equal(resolveLLMTimeoutMs({
        stage: 'r1',
        provider: 'claude',
        env: {
          CLAUDE_TIMEOUT_MS: '3000',
          R1_CLAUDE_TIMEOUT_MS: '1234',
        },
      }), 1234);
      assert.equal(resolveLLMTimeoutMs({
        stage: 'refresh:audits',
        provider: 'openai',
        env: {
          REFRESH_OPENAI_TIMEOUT_MS: '5000',
          REFRESH_AUDITS_OPENAI_TIMEOUT_MS: '2500',
        },
      }), 2500);
    },
  },
  {
    name: 'runStructuredLLM dispatches to OpenAI-compatible runner',
    fn: async () => {
      let args = null;
      const env = {
        R2_LLM_PROVIDER: 'openai',
        OPENAI_BASE_URL: 'https://llm.example/v1',
        OPENAI_API_KEY: 'test-key',
        OPENAI_MODEL: 'gpt-test',
      };
      const envelope = await runStructuredLLM({
        stage: 'r2',
        env,
        userPrompt: 'prompt',
        schemaJson: { type: 'object' },
        model: 'claude-sonnet-4-6',
        runOpenAIImpl: async (input) => {
          args = input;
          return { structured_output: { ok: true }, total_cost_usd: null, num_turns: 1 };
        },
      });

      assert.equal(args.model, 'gpt-test');
      assert.equal(args.baseUrl, 'https://llm.example/v1');
      assert.equal(args.apiKey, 'test-key');
      assert.equal(args.strictSchema, false);
      assert.deepEqual(envelope.structured_output, { ok: true });
      assert.equal(envelope.total_cost_usd, null);
    },
  },
  {
    name: 'runStructuredLLM allows enforced OpenAI-compatible budget when pricing is configured',
    fn: async () => {
      let args = null;
      const envelope = await runStructuredLLM({
        stage: 'r2',
        env: {
          R2_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'gpt-test',
          OPENAI_INPUT_COST_PER_1M: '2',
          OPENAI_OUTPUT_COST_PER_1M: '8',
        },
        userPrompt: 'prompt',
        schemaJson: { type: 'object' },
        maxBudgetUsd: 0.5,
        budgetEnforced: true,
        runOpenAIImpl: async (input) => {
          args = input;
          return { structured_output: { ok: true }, total_cost_usd: 0.01, num_turns: 1 };
        },
      });

      assert.deepEqual(args.pricing, { inputCostPer1M: 2, outputCostPer1M: 8 });
      assert.equal(args.maxBudgetUsd, 0.5);
      assert.equal(envelope.total_cost_usd, 0.01);
    },
  },
  {
    name: 'runStructuredLLM rejects OpenAI-compatible runner when USD cap must be enforced',
    fn: async () => {
      await assert.rejects(
        () => runStructuredLLM({
          stage: 'r2',
          env: {
            R2_LLM_PROVIDER: 'openai',
            OPENAI_API_KEY: 'test-key',
            OPENAI_MODEL: 'gpt-test',
          },
          userPrompt: 'prompt',
          schemaJson: { type: 'object' },
          maxBudgetUsd: 0.5,
          budgetEnforced: true,
          runOpenAIImpl: async () => {
            throw new Error('openai should not run');
          },
        }),
        (err) => err.kind === 'budget_unknown' && /cannot honor USD budget caps/.test(err.message),
      );
    },
  },
  {
    name: 'runStructuredLLM keeps Claude as default',
    fn: async () => {
      let args = null;
      const envelope = await runStructuredLLM({
        stage: 'r1',
        env: {},
        userPrompt: 'prompt',
        schemaJson: { type: 'object' },
        model: 'claude-sonnet-4-6',
        runClaudeImpl: async (input) => {
          args = input;
          return { structured_output: { ok: true }, total_cost_usd: 0.01, num_turns: 2 };
        },
      });

      assert.equal(args.model, 'claude-sonnet-4-6');
      assert.equal(args.allowedTools, 'WebFetch,WebSearch');
      assert.equal(args.timeoutMs, undefined);
      assert.equal(envelope.num_turns, 2);
    },
  },
  {
    name: 'runStructuredLLM passes resolved Claude timeout and spawn hook',
    fn: async () => {
      let args = null;
      const onSpawn = () => {};
      const envelope = await runStructuredLLM({
        stage: 'r1',
        env: { R1_CLAUDE_TIMEOUT_MS: '9876' },
        userPrompt: 'prompt',
        schemaJson: { type: 'object' },
        onSpawn,
        runClaudeImpl: async (input) => {
          args = input;
          return { structured_output: { ok: true }, total_cost_usd: 0.01, num_turns: 2 };
        },
      });

      assert.equal(args.timeoutMs, 9876);
      assert.equal(args.onSpawn, onSpawn);
      assert.deepEqual(envelope.structured_output, { ok: true });
    },
  },
];
