import { strict as assert } from 'node:assert';
import { openAIPricingFromEnv, runOpenAIChatCompletion } from '../../framework/openai-wrapper.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

export const tests = [
  {
    name: 'runOpenAIChatCompletion sends strict json_schema and parses content',
    fn: async () => {
      let request = null;
      const env = await runOpenAIChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1/',
        model: 'gpt-test',
        systemPrompt: 'translate',
        userPrompt: 'payload',
        schemaJson: {
          type: 'object',
          additionalProperties: false,
          required: ['description'],
          properties: { description: { type: 'string' } },
        },
        fetchImpl: async (url, options) => {
          request = { url, options, body: JSON.parse(options.body) };
          return jsonResponse({
            id: 'chatcmpl-test',
            model: 'gpt-test',
            choices: [
              { message: { content: '{"description":"你好"}' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          });
        },
      });

      assert.equal(request.url, 'https://llm.example/v1/chat/completions');
      assert.equal(request.options.headers.Authorization, 'Bearer test-key');
      assert.equal(request.body.response_format.type, 'json_schema');
      assert.equal(request.body.response_format.json_schema.strict, true);
      assert.deepEqual(env.structured_output, { description: '你好' });
      assert.equal(env.provider, 'openai');
      assert.equal(env.model, 'gpt-test');
      assert.equal(env.num_turns, 1);
      assert.equal(env.total_cost_usd, null);
      assert.deepEqual(env.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    },
  },
  {
    name: 'openAIPricingFromEnv parses per-million and per-thousand pricing',
    fn: async () => {
      assert.deepEqual(
        openAIPricingFromEnv({ OPENAI_INPUT_COST_PER_1M: '1.25', OPENAI_OUTPUT_COST_PER_1M: '10' }),
        { inputCostPer1M: 1.25, outputCostPer1M: 10 },
      );
      assert.deepEqual(
        openAIPricingFromEnv({ R2_OPENAI_INPUT_COST_PER_1K: '0.001', R2_OPENAI_OUTPUT_COST_PER_1K: '0.002' }, 'R2_OPENAI'),
        { inputCostPer1M: 1, outputCostPer1M: 2 },
      );
    },
  },
  {
    name: 'runOpenAIChatCompletion calculates cost when pricing is configured',
    fn: async () => {
      const env = await runOpenAIChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        model: 'gpt-test',
        userPrompt: 'payload',
        schemaJson: { type: 'object' },
        pricing: { inputCostPer1M: 2, outputCostPer1M: 8 },
        fetchImpl: async () => jsonResponse({
          choices: [
            { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
      });

      assert.equal(env.total_cost_usd, 0.006);
    },
  },
  {
    name: 'runOpenAIChatCompletion retries one transient response',
    fn: async () => {
      let calls = 0;
      const env = await runOpenAIChatCompletion({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        model: 'gpt-test',
        userPrompt: 'payload',
        schemaJson: { type: 'object' },
        retryDelayMs: 1,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            return jsonResponse({ error: { message: 'overloaded' } }, { ok: false, status: 503 });
          }
          return jsonResponse({
            choices: [
              { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
            ],
          });
        },
      });

      assert.equal(calls, 2);
      assert.deepEqual(env.structured_output, { ok: true });
    },
  },
  {
    name: 'runOpenAIChatCompletion rejects missing API key before fetch',
    fn: async () => {
      await assert.rejects(
        () => runOpenAIChatCompletion({
          apiKey: '',
          baseUrl: 'https://llm.example/v1',
          model: 'gpt-test',
          userPrompt: 'payload',
          schemaJson: { type: 'object' },
          fetchImpl: async () => {
            throw new Error('fetch should not run');
          },
        }),
        /OPENAI_API_KEY/
      );
    },
  },
];
