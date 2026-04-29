import { strict as assert } from 'node:assert';
import { analyzeKey } from '../../framework/key-analyzer.mjs';

const manifestPath = `${process.cwd()}/consumers/protocol-info/manifest.json`;

export const tests = [
  {
    name: 'analyzeKey renders field context and parses a proposal',
    fn: async () => {
      let call = null;
      const proposal = await analyzeKey({
        slug: 'pendle',
        jsonpath: 'description',
        query: 'verify current description',
        currentValue: 'old description',
        record: { name: 'Pendle', description: 'old description' },
        evidence: { rootdata: { anchors: [{ website: 'https://example.com' }] } },
        manifestPath,
        runClaude: async (args) => {
          call = args;
          return {
            structured_output: {
              ok: true,
              path: 'description',
              proposed_value: 'new description',
              reason: 'source supports a tighter description',
              confidence: 0.9,
              findings: [],
              changes: [],
              gaps: [],
            },
          };
        },
        searchFetchers: [],
      });

      assert.equal(proposal.ok, true);
      assert.equal(proposal.proposed_value, 'new description');
      assert.equal(call.maxTurns, 30);
      assert.equal(call.schemaJson.properties.proposed_value.type, undefined);
      assert.match(call.userPrompt, /JSONPath: description/);
      assert.match(call.userPrompt, /verify current description/);
      assert.match(call.userPrompt, /old description/);
      assert.match(call.userPrompt, /"anchors"/);
    },
  },
  {
    name: 'analyzeKey can route through structured LLM runner',
    fn: async () => {
      let call = null;
      const proposal = await analyzeKey({
        slug: 'pendle',
        jsonpath: 'description',
        query: 'verify current description',
        currentValue: 'old description',
        record: { name: 'Pendle', description: 'old description' },
        evidence: {},
        manifestPath,
        llmProvider: 'openai',
        runLLM: async (args) => {
          call = args;
          return {
            structured_output: {
              ok: true,
              path: 'description',
              proposed_value: 'new description',
              reason: 'evidence-only proposal',
              confidence: 0.8,
              findings: [],
              changes: [],
              gaps: [],
            },
          };
        },
        searchFetchers: [],
      });

      assert.equal(call.stage, 'analyze');
      assert.equal(call.provider, 'openai');
      assert.equal(proposal.ok, true);
      assert.equal(proposal.proposed_value, 'new description');
    },
  },
  {
    name: 'analyzeKey treats explicit max budget as enforced for external LLM routing',
    fn: async () => {
      let call = null;
      const proposal = await analyzeKey({
        slug: 'pendle',
        jsonpath: 'description',
        query: 'verify current description',
        currentValue: 'old description',
        record: { name: 'Pendle', description: 'old description' },
        evidence: {},
        manifestPath,
        llmProvider: 'openai',
        maxBudgetUsd: 0.25,
        runLLM: async (args) => {
          call = args;
          assert.equal(args.budgetEnforced, true);
          throw Object.assign(new Error('OpenAI-compatible LLM provider cannot honor USD budget caps without pricing configuration'), {
            kind: 'budget_unknown',
          });
        },
        searchFetchers: [],
      });

      assert.equal(call.provider, 'openai');
      assert.equal(call.maxBudgetUsd, 0.25);
      assert.equal(proposal.ok, false);
      assert.match(proposal.reason, /cannot honor USD budget caps/);
    },
  },
  {
    name: 'analyzeKey executes approved search requests before final proposal',
    fn: async () => {
      const prompts = [];
      const proposal = await analyzeKey({
        slug: 'pendle',
        jsonpath: 'description',
        query: 'verify current description',
        currentValue: 'old description',
        record: { name: 'Pendle', description: 'old description' },
        evidence: {},
        manifestPath,
        runClaude: async ({ userPrompt }) => {
          prompts.push(userPrompt);
          if (prompts.length === 1) {
            return {
              structured_output: {
                ok: false,
                path: 'description',
                reason: 'need search',
                confidence: 0.2,
                findings: [],
                changes: [],
                gaps: [],
                search_requests: [
                  { channel: 'rootdata', type: 'project', query: 'Pendle', reason: 'lookup project', limit: 1 },
                ],
              },
            };
          }
          return {
            structured_output: {
              ok: true,
              path: 'description',
              proposed_value: 'new description',
              reason: 'search result supports it',
              confidence: 0.8,
              findings: [],
              changes: [],
              gaps: [],
            },
          };
        },
        runSearchRequests: async ({ requests }) => {
          assert.equal(requests[0].query, 'Pendle');
          return [{ channel: 'rootdata', query: 'Pendle', ok: true, results: [{ name: 'Pendle' }] }];
        },
        searchFetchers: [{ name: 'rootdata', search: async () => ({ ok: true, results: [] }) }],
      });

      assert.equal(prompts.length, 2);
      assert.match(prompts[1], /search_results/);
      assert.equal(proposal.ok, true);
      assert.equal(proposal.proposed_value, 'new description');
    },
  },
];
