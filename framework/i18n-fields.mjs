import { parse as parseJsonPath } from './jsonpath.mjs';
import { extractTranslatable } from './i18n-stage.mjs';

export function parseTranslatablePath(path) {
  return String(path).split('.').flatMap((part) => {
    if (part.endsWith('[]')) return [part.slice(0, -2), '[]'];
    return [part];
  }).filter(Boolean);
}

function segmentsMatch(a, b) {
  return a === b || (a === '[]' && typeof b === 'number') || (b === '[]' && typeof a === 'number');
}

function isPrefixPath(prefix, full) {
  if (prefix.length > full.length) return false;
  return prefix.every((segment, index) => segmentsMatch(segment, full[index]));
}

export function pathAffectsTranslatableFields(jsonpath, translatableFields = []) {
  const changed = parseJsonPath(jsonpath);
  return translatableFields.some((field) => {
    const translated = parseTranslatablePath(field);
    return isPrefixPath(changed, translated) || isPrefixPath(translated, changed);
  });
}

export function translatableSubsetChanged(before, after, translatableFields = []) {
  if (!Array.isArray(translatableFields) || translatableFields.length === 0) return false;
  const beforeSubset = extractTranslatable(before || {}, translatableFields);
  const afterSubset = extractTranslatable(after || {}, translatableFields);
  return JSON.stringify(beforeSubset) !== JSON.stringify(afterSubset);
}
