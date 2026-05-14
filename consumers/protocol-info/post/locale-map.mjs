// consumers/protocol-info/post/locale-map.mjs
// Maps manifest locale codes to the dashboard i18n keys.
// Source fallback is `en`; translated regional variants keep their region,
// e.g. en_US -> en-us, fr_FR -> fr-fr, ja_JP -> ja-jp.

export const DASHBOARD_LOCALE_CODES = Object.freeze([
  'en',
  'en-us',
  'zh-cn',
  'zh-tw',
  'zh-hk',
  'ja-jp',
  'ko-kr',
  'fr-fr',
  'de',
  'es',
  'it-it',
  'pt-br',
  'pt',
  'ru',
  'uk-ua',
  'ar',
  'hi-in',
  'bn',
  'vi',
  'th-th',
  'id',
]);

const DASHBOARD_LOCALE_SET = new Set(DASHBOARD_LOCALE_CODES);

export function dashboardLocaleFor(code) {
  const locale = String(code || '').trim().toLowerCase().replace(/_/g, '-');
  if (!DASHBOARD_LOCALE_SET.has(locale)) {
    throw new Error(`locale "${code}" maps to unsupported dashboard locale "${locale}"`);
  }
  return locale;
}
