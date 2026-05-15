export function buildI18nSchema({
  fullSchema,
  translatableFields,
  fieldCaps = {},
  title = 'EarnProtocolInfo i18n payload (one locale)',
  description = 'Translated text fields for a single locale. Generated from manifest.i18n.translatable_fields and the canonical schema.',
} = {}) {
  if (!fullSchema || typeof fullSchema !== 'object') {
    throw new Error('buildI18nSchema: fullSchema is required');
  }
  if (!Array.isArray(translatableFields) || translatableFields.length === 0) {
    throw new Error('buildI18nSchema: translatableFields must be a non-empty array');
  }

  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'i18n.schema.json',
    title,
    description,
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {},
  };

  for (const field of translatableFields) {
    addFieldSchema(schema, fullSchema, parsePath(field), fieldCaps[field]);
  }

  return schema;
}

export function parseI18nPath(path) {
  return parsePath(path);
}

function parsePath(path) {
  return String(path).split('.').flatMap((part) => {
    if (part.endsWith('[]')) return [part.slice(0, -2), '[]'];
    return [part];
  }).filter(Boolean);
}

function addFieldSchema(target, source, segments, cap) {
  if (segments.length === 0) return;
  const [segment, ...rest] = segments;

  if (segment === '[]') {
    if (!source.items) throw new Error('i18n schema generation: array source is missing items schema');
    target.type = 'array';
    copyIfPresent(source, target, ['minItems', 'maxItems']);
    target.items ??= objectSchema();
    addFieldSchema(target.items, source.items, rest, cap);
    return;
  }

  const sourceProp = source.properties?.[segment];
  if (!sourceProp) {
    throw new Error(`i18n schema generation: source schema missing property ${segment}`);
  }

  if (rest.length === 0) {
    target.properties ??= {};
    target.required ??= [];
    target.properties[segment] = leafSchema(sourceProp, cap);
    pushUnique(target.required, segment);
    return;
  }

  target.properties ??= {};
  target.required ??= [];
  if (!target.properties[segment]) {
    target.properties[segment] = containerSchema(sourceProp);
  }
  pushUnique(target.required, segment);
  addFieldSchema(target.properties[segment], sourceProp, rest, cap);
}

function objectSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {},
  };
}

function containerSchema(source) {
  if (schemaAllowsType(source, 'array')) {
    const out = { type: 'array' };
    copyIfPresent(source, out, ['minItems', 'maxItems']);
    out.items = objectSchema();
    return out;
  }
  if (schemaAllowsType(source, 'object')) {
    return objectSchema();
  }
  throw new Error('i18n schema generation: translatable path crosses a non-container schema');
}

function leafSchema(source, cap) {
  const out = {};
  if (source.type !== undefined) out.type = cloneJson(source.type);
  if (source.enum) out.enum = cloneJson(source.enum);
  if (source.pattern) out.pattern = source.pattern;
  if (source.maxLength != null) out.maxLength = source.maxLength;

  const capValue = typeof cap === 'number' ? cap : cap?.maxLength;
  if (capValue != null) {
    out.maxLength = out.maxLength == null ? capValue : Math.min(out.maxLength, capValue);
  }
  return out;
}

function schemaAllowsType(schema, type) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return types.includes(type);
}

function copyIfPresent(source, target, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = cloneJson(source[key]);
  }
}

function pushUnique(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
