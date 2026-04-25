#!/usr/bin/env node
// Verifies each slice schema's properties are a strict subset of full.json's properties,
// and that each property's validation semantics match.
//
// This catches drift when full.json is updated but a slice is forgotten.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FULL = resolve(ROOT, 'consumers/protocol-info/schemas/full.json');
const SLICES = [
  'metadata.slice.json',
  'team.slice.json',
  'funding.slice.json',
  'audits.slice.json',
].map(f => resolve(ROOT, 'consumers/protocol-info/schemas', f));

const fullSchema = JSON.parse(await readFile(FULL, 'utf8'));
const fullProps = fullSchema.properties || {};
let problems = 0;

const ANNOTATION_KEYS = new Set(['$schema', '$id', 'title', 'description', 'examples', 'default']);
function canonicalValidationShape(node) {
  if (Array.isArray(node)) return node.map(canonicalValidationShape);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (ANNOTATION_KEYS.has(key)) continue;
    out[key] = canonicalValidationShape(node[key]);
  }
  return out;
}

for (const slicePath of SLICES) {
  const slice = JSON.parse(await readFile(slicePath, 'utf8'));
  const props = slice.properties || {};
  for (const [k, v] of Object.entries(props)) {
    if (!(k in fullProps)) {
      console.error(`✗ ${slicePath}: property "${k}" not in full.json`);
      problems++;
      continue;
    }
    const a = JSON.stringify(canonicalValidationShape(v));
    const b = JSON.stringify(canonicalValidationShape(fullProps[k]));
    if (a !== b) {
      console.error(`✗ ${slicePath}: property "${k}" validation semantics diverge from full.json`);
      problems++;
    }
  }
  // Required check
  for (const r of (slice.required || [])) {
    if (!(r in fullProps)) {
      console.error(`✗ ${slicePath}: required "${r}" not in full.json properties`);
      problems++;
    }
  }
}

if (problems === 0) console.log('✓ slice schemas coherent with full.json');
process.exit(problems === 0 ? 0 : 1);
