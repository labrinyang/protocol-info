#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTranslation } from '../translate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _pass = 0, _fail = 0;
function assert(condition, msg) {
  if (condition) _pass++;
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b),
    `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
process.on('exit', () => {
  console.log(`  ${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exitCode = 1;
});

// ── Setup ──

const source = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'morpho-en.json'), 'utf8'));

const translated = {
  description: 'Morpho是一个去中心化借贷协议，通过在现有借贷池之上进行点对点匹配来优化利率。',
  tags: ['借贷', '去中心化金融', '收益优化'],
  memberPositions: ['联合创始人兼首席执行官', '联合创始人兼首席技术官'],
  memberOneLiners: ['巴黎电信学院毕业生，在校期间构思了Morpho', null],
  fundingRounds: ['A轮融资', '种子轮'],
};

const merged = mergeTranslation(source, translated, 'zh-cn');

// ── Locale field ──
assertEq(merged.locale, 'zh-cn', 'locale is set');

// ── Translated fields are replaced ──
assertEq(merged.description, translated.description, 'description translated');
assertEq(merged.tags, translated.tags, 'tags translated');
assertEq(merged.members[0].memberPosition, '联合创始人兼首席执行官', 'member[0] position translated');
assertEq(merged.members[1].memberPosition, '联合创始人兼首席技术官', 'member[1] position translated');
assertEq(merged.members[0].oneLiner, '巴黎电信学院毕业生，在校期间构思了Morpho', 'member[0] oneLiner translated');
assertEq(merged.members[1].oneLiner, null, 'member[1] oneLiner stays null');
assertEq(merged.fundingRounds[0].round, 'A轮融资', 'round[0] translated');
assertEq(merged.fundingRounds[1].round, '种子轮', 'round[1] translated');

// ── Non-translatable fields preserved ──
assertEq(merged.slug, 'morpho', 'slug preserved');
assertEq(merged.provider, 'morpho', 'provider preserved');
assertEq(merged.displayName, 'Morpho', 'displayName preserved');
assertEq(merged.type, 'simple_earn', 'type preserved');
assertEq(merged.establishment, 2021, 'establishment preserved');
assertEq(merged.providerWebsite, 'https://morpho.org', 'website preserved');
assertEq(merged.members[0].memberName, 'Paul Frambot', 'memberName preserved');
assertEq(merged.members[0].avatarUrl, 'https://unavatar.io/x/PaulFrambot?fallback=false', 'avatarUrl preserved');
assertEq(merged.members[0].memberLink.xLink, 'https://x.com/PaulFrambot', 'xLink preserved');
assertEq(merged.fundingRounds[0].date, '2023-07', 'date preserved');
assertEq(merged.fundingRounds[0].amount, '$18M', 'amount preserved');
assertEq(merged.fundingRounds[0].investors, ['a16z crypto', 'Variant Fund', 'Nascent'], 'investors preserved');
assertEq(merged.audits.items[0].auditor, 'Trail of Bits', 'auditor preserved');

// ── sources stripped ──
assert(merged.sources === undefined, 'sources removed from translated output');

// ── Source data not mutated ──
assert(source.locale === undefined, 'source data not mutated');
assert(source.sources !== undefined, 'source sources not removed');

// ── Defensive merge: shorter translated arrays ──
const partialTranslated = {
  description: '部分翻译',
  tags: ['借贷'],
  memberPositions: ['联合创始人兼首席执行官'],
  memberOneLiners: ['巴黎电信毕业'],
  fundingRounds: ['A轮'],
};

const partialMerged = mergeTranslation(source, partialTranslated, 'zh-cn');
assertEq(partialMerged.members[0].memberPosition, '联合创始人兼首席执行官', 'partial: member[0] translated');
assertEq(partialMerged.members[1].memberPosition, 'Co-founder & CTO', 'partial: member[1] falls back to English');
assertEq(partialMerged.fundingRounds[0].round, 'A轮', 'partial: round[0] translated');
assertEq(partialMerged.fundingRounds[1].round, 'Seed', 'partial: round[1] falls back to English');
