// consumers/protocol-info/post/locale-map.mjs
// Maps manifest locale codes to the dashboard i18n keys:
// source fallback is `en`; translated regional variants keep their region,
// e.g. en_US -> en-us, fr_FR -> fr-fr, ja_JP -> ja-jp.

export function dashboardLocaleFor(code) {
  return String(code || '').trim().toLowerCase().replace(/_/g, '-');
}
