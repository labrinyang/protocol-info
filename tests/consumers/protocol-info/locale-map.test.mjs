import { strict as assert } from 'node:assert';
import { dashboardLocaleFor, DASHBOARD_LOCALE_CODES } from '../../../consumers/protocol-info/post/locale-map.mjs';

export const tests = [
  { name: 'en → en', fn: async () => assert.equal(dashboardLocaleFor('en'), 'en') },
  { name: 'en_US → en-us', fn: async () => assert.equal(dashboardLocaleFor('en_US'), 'en-us') },
  { name: 'zh_CN → zh-cn', fn: async () => assert.equal(dashboardLocaleFor('zh_CN'), 'zh-cn') },
  { name: 'zh_HK → zh-hk', fn: async () => assert.equal(dashboardLocaleFor('zh_HK'), 'zh-hk') },
  { name: 'pt_BR → pt-br', fn: async () => assert.equal(dashboardLocaleFor('pt_BR'), 'pt-br') },
  { name: 'pt → pt', fn: async () => assert.equal(dashboardLocaleFor('pt'), 'pt') },
  { name: 'fr_FR → fr-fr', fn: async () => assert.equal(dashboardLocaleFor('fr_FR'), 'fr-fr') },
  { name: 'ja_JP → ja-jp', fn: async () => assert.equal(dashboardLocaleFor('ja_JP'), 'ja-jp') },
  { name: 'ko_KR → ko-kr', fn: async () => assert.equal(dashboardLocaleFor('ko_KR'), 'ko-kr') },
  { name: 'hi_IN → hi-in', fn: async () => assert.equal(dashboardLocaleFor('hi_IN'), 'hi-in') },
  { name: 'it_IT → it-it', fn: async () => assert.equal(dashboardLocaleFor('it_IT'), 'it-it') },
  { name: 'th_TH → th-th', fn: async () => assert.equal(dashboardLocaleFor('th_TH'), 'th-th') },
  { name: 'uk_UA → uk-ua', fn: async () => assert.equal(dashboardLocaleFor('uk_UA'), 'uk-ua') },
  { name: 'ar → ar', fn: async () => assert.equal(dashboardLocaleFor('ar'), 'ar') },
  { name: 'known dashboard catalog includes source and translated locales', fn: async () => assert.equal(DASHBOARD_LOCALE_CODES.length, 21) },
  { name: 'unknown locale fails loudly', fn: async () => assert.throws(() => dashboardLocaleFor('XX'), /unsupported dashboard locale/) },
];
