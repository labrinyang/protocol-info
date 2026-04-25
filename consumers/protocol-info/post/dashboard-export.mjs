// consumers/protocol-info/post/dashboard-export.mjs
// Builds the dashboard import envelope: {version, exportedAt, data:[...]}.
// Source-language record gets locale='en' (sourceLocale param). Per
// successfully translated locale, mergeTranslated overlays translation onto
// the stripped record and locale is mapped via dashboardLocaleFor.

import { dashboardLocaleFor } from './locale-map.mjs';
import { mergeTranslated } from '../../../framework/i18n-stage.mjs';

export function buildImportFile({ record, translations, sourceLocale = 'en', stripFields = ['sources'] }) {
  const stripped = (r) => {
    const out = { ...r };
    for (const f of stripFields) delete out[f];
    return out;
  };

  const baseEn = { ...stripped(record), locale: sourceLocale };
  const data = [baseEn];
  for (const [code, tr] of Object.entries(translations || {})) {
    const merged = mergeTranslated(stripped(record), tr);
    data.push({ ...merged, locale: dashboardLocaleFor(code) });
  }

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    data,
  };
}
