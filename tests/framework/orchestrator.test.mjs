// Sanity tests for framework/orchestrator.mjs.
// Phase 9.1 ships a glue module; deep behavior is exercised by Phase 9.4 e2e.
// Here we just guarantee the module loads and exports the public surface.

import { strict as assert } from 'node:assert';
import {
  run,
  runOne,
  slugify,
  resolveI18nSelection,
  computeBudgetPlan,
  protocolRunDir,
  runIndexDir,
} from '../../framework/orchestrator.mjs';

export const tests = [
  {
    name: 'orchestrator module exports run + runOne',
    fn: async () => {
      assert.equal(typeof run, 'function');
      assert.equal(typeof runOne, 'function');
    },
  },
  {
    name: 'slugify mirrors run.sh slugify()',
    fn: async () => {
      assert.equal(slugify('f(x)Protocol'), 'f-x-protocol');
      assert.equal(slugify('Saturn Credit'), 'saturn-credit');
      assert.equal(slugify('  Pendle!! '), 'pendle');
      assert.equal(slugify(''), '');
    },
  },
  {
    name: 'resolveI18nSelection: empty/none → []',
    fn: async () => {
      assert.deepEqual(resolveI18nSelection('', { i18n: { locale_catalog: [{ code: 'zh_CN' }] } }), []);
      assert.deepEqual(resolveI18nSelection('none', { i18n: { locale_catalog: [{ code: 'zh_CN' }] } }), []);
    },
  },
  {
    name: 'resolveI18nSelection: all → manifest catalog codes',
    fn: async () => {
      const manifest = { i18n: { locale_catalog: [{ code: 'zh_CN' }, { code: 'ja_JP' }] } };
      assert.deepEqual(resolveI18nSelection('all', manifest), ['zh_CN', 'ja_JP']);
    },
  },
  {
    name: 'resolveI18nSelection: comma list passes through trimmed',
    fn: async () => {
      assert.deepEqual(
        resolveI18nSelection('zh_CN, ja_JP ,en_US', { i18n: { locale_catalog: [] } }),
        ['zh_CN', 'ja_JP', 'en_US'],
      );
    },
  },
  {
    name: 'computeBudgetPlan scales stage totals under single-provider cap',
    fn: async () => {
      const manifest = {
        subtasks: [{ max_budget_usd: 1 }, { max_budget_usd: 3 }],
        reconcile: { enabled: true, max_budget_usd: 2, max_research_rounds: 2 },
        i18n: { max_budget_usd_per_call: 0.5 },
      };
      const plan = computeBudgetPlan(manifest, { maxBudget: 4, i18nLocaleCount: 2 });
      assert.equal(plan.defaults.total, 9);
      assert.ok(plan.effective.total <= 4);
      assert.ok(plan.effective.total > 3.99);
      assert.ok(plan.effective.r1_total > 0);
      assert.ok(plan.effective.r2_total > 0);
      assert.ok(plan.effective.i18n_total > 0);
    },
  },
  {
    name: 'computeBudgetPlan leaves defaults unchanged without user cap',
    fn: async () => {
      const manifest = {
        subtasks: [{ max_budget_usd: 1 }],
        reconcile: { enabled: true, max_budget_usd: 2, max_research_rounds: 2 },
        i18n: { max_budget_usd_per_call: 0.1 },
      };
      const plan = computeBudgetPlan(manifest, { i18nLocaleCount: 3 });
      assert.equal(plan.mode, 'manifest_defaults');
      assert.equal(plan.effective.total, 5.3);
    },
  },
  {
    name: 'output paths are protocol-first with run index separated',
    fn: async () => {
      assert.equal(protocolRunDir('/tmp/out', 'pendle', '20260427T010203Z'), '/tmp/out/pendle/20260427T010203Z');
      assert.equal(runIndexDir('/tmp/out', '20260427T010203Z'), '/tmp/out/_runs/20260427T010203Z');
    },
  },
];
