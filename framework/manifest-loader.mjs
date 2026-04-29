// Reads + validates a consumer manifest. Resolves all relative paths
// (modules, prompts, schemas) to absolute; attaches under `manifest._abs`.
//
// Throws on invalid JSON, schema validation failure, or missing referenced files.

import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_SCHEMA = resolve(FRAMEWORK_DIR, 'schemas/consumer-manifest.schema.json');

function abs(base, rel) {
  if (!rel) return null;
  return isAbsolute(rel) ? rel : resolve(base, rel);
}

async function assertFile(label, path) {
  if (!path) return;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error('not a file');
  } catch (err) {
    throw new Error(`missing referenced file (${label}): ${path}`);
  }
}

export async function loadManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (e) { throw new Error(`manifest JSON parse: ${e.message}`); }

  // Validate against the manifest schema using framework/schema-validator.mjs
  const validator = resolve(FRAMEWORK_DIR, 'schema-validator.mjs');
  // schema-validator emits validation errors on stdout; stderr only on argv/usage errors.
  const r = spawnSync('node', [validator, manifestPath, '--schema', MANIFEST_SCHEMA], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`manifest schema validation failed:\n${r.stderr || r.stdout}`);
  }

  const baseDir = dirname(resolve(manifestPath));

  manifest._abs = {
    base_dir: baseDir,
    full_schema: abs(baseDir, manifest.schemas?.full),
    system_prompt: abs(baseDir, manifest.system_prompt),
    fetchers: (manifest.fetchers || []).map(f => ({
      ...f,
      module_abs: abs(baseDir, f.module),
    })),
    subtasks: (manifest.subtasks || []).map(s => ({
      ...s,
      prompt_abs: abs(baseDir, s.prompt),
      evidence_prompt_abs: abs(baseDir, s.evidence_prompt),
      schema_slice_abs: abs(baseDir, s.schema_slice),
    })),
    reconcile_prompt: abs(baseDir, manifest.reconcile?.prompt),
    reconcile_evidence_prompt: abs(baseDir, manifest.reconcile?.evidence_prompt),
    i18n: manifest.i18n ? {
      ...manifest.i18n,
      system_prompt_abs: abs(baseDir, manifest.i18n.system_prompt),
      user_prompt_abs:   abs(baseDir, manifest.i18n.user_prompt),
      schema_abs:        abs(baseDir, manifest.i18n.schema),
    } : null,
    normalizers: (manifest.normalizers || []).map(n => ({
      ...n,
      module_abs: abs(baseDir, n.module),
    })),
    post_processing: (manifest.post_processing || []).map(p => ({
      ...p,
      module_abs: abs(baseDir, p.module),
    })),
  };

  const refs = [
    ['full schema', manifest._abs.full_schema],
    ['system prompt', manifest._abs.system_prompt],
    ['reconcile prompt', manifest._abs.reconcile_prompt],
    ['reconcile evidence prompt', manifest._abs.reconcile_evidence_prompt],
    ...(manifest._abs.fetchers || []).map(f => [`fetcher:${f.name}`, f.module_abs]),
    ...(manifest._abs.subtasks || []).flatMap(s => [
      [`subtask prompt:${s.name}`, s.prompt_abs],
      [`subtask evidence prompt:${s.name}`, s.evidence_prompt_abs],
      [`subtask schema:${s.name}`, s.schema_slice_abs],
    ]),
    ...(manifest._abs.normalizers || []).map(n => [`normalizer:${n.name}`, n.module_abs]),
    ...(manifest._abs.post_processing || []).map(p => [`post:${p.name}`, p.module_abs]),
  ];
  if (manifest._abs.i18n) {
    refs.push(
      ['i18n system prompt', manifest._abs.i18n.system_prompt_abs],
      ['i18n user prompt', manifest._abs.i18n.user_prompt_abs],
      ['i18n schema', manifest._abs.i18n.schema_abs],
    );
  }
  for (const [label, path] of refs) await assertFile(label, path);

  return manifest;
}

// Extract a subtree of the evidence packet by jq-style path keys.
// `keys`: array of dot-paths, e.g. ["rootdata.anchors", "defillama.category"]
// Returns an object { rootdata: { anchors: ... }, defillama: { category: ... } }
export function selectEvidence(packet, keys) {
  const out = {};
  for (const path of keys) {
    const parts = path.split('.');
    let src = packet;
    let dst = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!src || typeof src !== 'object' || !(p in src)) { src = null; break; }
      src = src[p];
      if (!(p in dst)) dst[p] = {};
      dst = dst[p];
    }
    if (src && typeof src === 'object') {
      const last = parts[parts.length - 1];
      if (last in src) dst[last] = src[last];
    }
  }
  return out;
}
