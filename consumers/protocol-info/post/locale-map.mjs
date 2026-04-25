// consumers/protocol-info/post/locale-map.mjs
// Maps our underscore-mixed-case locale codes to dashboard's hyphen-lowercase
// format. Drops redundant region suffixes when the language has only one
// variant (en_US → en, fr_FR → fr); keeps regions when there are multiple
// variants (pt_BR → pt-br, zh_CN → zh-cn, zh_HK → zh-hk).
//
// TODO: dashboard supports 21 locales; we currently configure 19. Update when
// authoritative list arrives.

const EXPLICIT = {
  en_US: 'en',
  fr_FR: 'fr',
  hi_IN: 'hi',
  it_IT: 'it',
  ja_JP: 'ja',
  ko_KR: 'ko',
  th_TH: 'th',
  uk_UA: 'uk',
  pt_BR: 'pt-br',
  zh_CN: 'zh-cn',
  zh_HK: 'zh-hk',
  zh_TW: 'zh-tw',
};
const BARE = new Set(['bn', 'de', 'es', 'id', 'pt', 'ru', 'vi']);

export function dashboardLocaleFor(code) {
  if (EXPLICIT[code]) return EXPLICIT[code];
  if (BARE.has(code)) return code;
  return code.toLowerCase().replace(/_/g, '-');
}
