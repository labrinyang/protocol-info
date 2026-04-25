import { strict as assert } from 'node:assert';
import { dashboardLocaleFor } from '../../../consumers/protocol-info/post/locale-map.mjs';

export const tests = [
  { name: 'en_US → en', fn: async () => assert.equal(dashboardLocaleFor('en_US'), 'en') },
  { name: 'zh_CN → zh-cn', fn: async () => assert.equal(dashboardLocaleFor('zh_CN'), 'zh-cn') },
  { name: 'zh_HK → zh-hk', fn: async () => assert.equal(dashboardLocaleFor('zh_HK'), 'zh-hk') },
  { name: 'pt_BR → pt-br', fn: async () => assert.equal(dashboardLocaleFor('pt_BR'), 'pt-br') },
  { name: 'pt → pt', fn: async () => assert.equal(dashboardLocaleFor('pt'), 'pt') },
  { name: 'fr_FR → fr', fn: async () => assert.equal(dashboardLocaleFor('fr_FR'), 'fr') },
  { name: 'ja_JP → ja', fn: async () => assert.equal(dashboardLocaleFor('ja_JP'), 'ja') },
  { name: 'unknown XX → xx (lowercase fallback)', fn: async () => assert.equal(dashboardLocaleFor('XX'), 'xx') },
];
