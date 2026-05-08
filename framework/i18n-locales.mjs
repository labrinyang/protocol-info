export function dashboardStyleLocale(code) {
  return String(code || '').trim().toLowerCase().replace(/_/g, '-');
}

export function normalizeI18nLocaleCode(code, manifest) {
  const raw = String(code || '').replace(/\s+/g, '');
  if (!raw) return '';
  const catalog = manifest?.i18n?.locale_catalog || [];
  if (catalog.length === 0) return raw;
  const aliases = new Map();
  for (const entry of catalog) {
    if (!entry?.code) continue;
    aliases.set(entry.code, entry.code);
    aliases.set(entry.code.toLowerCase(), entry.code);
    aliases.set(dashboardStyleLocale(entry.code), entry.code);
  }
  return aliases.get(raw) || aliases.get(raw.toLowerCase()) || aliases.get(dashboardStyleLocale(raw)) || raw;
}
