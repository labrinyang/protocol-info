#!/usr/bin/env node
// Zero-dep, consumer-agnostic JSON schema validator.
// Usage:
//   node framework/schema-validator.mjs --schema <schema.json> <file.json> [more.json ...]
//   node framework/schema-validator.mjs --schema my-schema.json out/20260422T093012Z/*.json   (glob expanded by shell)
// Exit 0 on all-pass, 1 on any violation, 2 on usage errors (missing --schema or no files).

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Parse argv: extract --schema <path> from anywhere; remaining tokens are file paths.
const argv = process.argv.slice(2);
const files = [];
let schemaPath = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--schema') {
    const next = argv[i + 1];
    if (!next) {
      console.error('error: --schema requires a path argument');
      process.exit(2);
    }
    schemaPath = resolve(next);
    i += 1;
  } else {
    files.push(arg);
  }
}

if (!schemaPath) {
  console.error('error: --schema <path> is required');
  process.exit(2);
}

if (files.length === 0) {
  console.error('usage: node framework/schema-validator.mjs --schema <schema.json> <file.json> [more.json ...]');
  process.exit(2);
}

const schema = JSON.parse(await readFile(schemaPath, 'utf8'));

let failed = 0;
for (const file of files) {
  const errors = await validateFile(file);
  if (errors.length === 0) {
    console.log(`OK    ${file}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${file}`);
    for (const e of errors) console.log(`        - ${e}`);
  }
}

process.exit(failed === 0 ? 0 : 1);

async function validateFile(file) {
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    return [`not parseable JSON: ${e.message}`];
  }
  return validate(data, schema, '$');
}

// --- Minimal JSON Schema subset (draft-07) covering what our schema uses ---
function validate(value, node, path) {
  const errs = [];

  // nullable handling: type may be an array including "null"
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : null;
  if (types) {
    if (value === null) {
      if (!types.includes('null')) errs.push(`${path}: null not allowed`);
      return errs;
    }
    if (!types.some((t) => matchType(value, t))) {
      errs.push(`${path}: expected ${types.join('|')}, got ${jsType(value)}`);
      return errs;
    }
  }

  if (node.enum && !node.enum.includes(value)) {
    errs.push(`${path}: value "${value}" not in enum [${node.enum.join(', ')}]`);
  }

  if (typeof value === 'string') {
    if (node.minLength != null && value.length < node.minLength)
      errs.push(`${path}: string shorter than minLength ${node.minLength}`);
    if (node.maxLength != null && value.length > node.maxLength)
      errs.push(`${path}: string longer than maxLength ${node.maxLength}`);
    if (node.pattern && !new RegExp(node.pattern).test(value))
      errs.push(`${path}: does not match pattern ${node.pattern}`);
    if (node.format === 'uri' && !isUri(value))
      errs.push(`${path}: not a valid absolute URI`);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (node.minimum != null && value < node.minimum)
      errs.push(`${path}: ${value} < minimum ${node.minimum}`);
    if (node.maximum != null && value > node.maximum)
      errs.push(`${path}: ${value} > maximum ${node.maximum}`);
  }

  if (Array.isArray(value)) {
    if (node.minItems != null && value.length < node.minItems)
      errs.push(`${path}: array length ${value.length} < minItems ${node.minItems}`);
    if (node.maxItems != null && value.length > node.maxItems)
      errs.push(`${path}: array length ${value.length} > maxItems ${node.maxItems}`);
    if (node.items) {
      value.forEach((item, i) => errs.push(...validate(item, node.items, `${path}[${i}]`)));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = node.properties || {};
    const required = node.required || [];
    for (const key of required) {
      if (!(key in value)) errs.push(`${path}.${key}: required but missing`);
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errs.push(`${path}.${key}: additional property not allowed`);
      }
    }
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in value) {
        errs.push(...validate(value[key], subSchema, `${path}.${key}`));
      }
    }
  }

  return errs;
}

function matchType(value, t) {
  switch (t) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isUri(s) {
  try {
    const u = new URL(s);
    return !!u.protocol && !!u.host;
  } catch {
    return false;
  }
}
