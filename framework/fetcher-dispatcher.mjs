// Calls all manifest-declared fetchers in parallel via parallel-runner,
// merges results into a single evidence packet.
//
// Output shape:
//   {
//     fetchers_run: ['rootdata', 'defillama', ...],
//     fetcher_status: { rootdata: 'ok' | 'failed: <reason>' | 'skipped: <reason>', ... },
//     <fetcher name>: <fetcher data>,    // only when ok
//     fetched_at: '<ISO>'
//   }

import { runWithLimit } from './parallel-runner.mjs';
import { pathToFileURL } from 'node:url';

function hasEnvValue(env, key) {
  if (env?.[key]) return true;
  if (key === 'ROOTDATA_API_KEY') {
    if (env?.ROOTDATA_API_KEYS) return true;
    return Object.keys(env || {}).some((k) => /^ROOTDATA_API_KEY_\d+$/i.test(k) && env[k]);
  }
  return false;
}

export async function dispatchFetchers({ fetchers, ctx, concurrency = 4 }) {
  const status = {};

  const tasks = fetchers.map(f => async () => {
    // env-gating
    const missingEnv = (f.required_env || []).filter(k => !hasEnvValue(ctx.env, k));
    if (missingEnv.length > 0) {
      status[f.name] = `skipped: missing env ${missingEnv.join(',')}`;
      return null;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(f.module_abs).href);
    } catch (err) {
      status[f.name] = `failed: import error: ${err.message}`;
      return null;
    }
    if (typeof mod.default !== 'function') {
      status[f.name] = `failed: module has no default export`;
      return null;
    }
    let result;
    try {
      result = await mod.default(ctx);
    } catch (err) {
      status[f.name] = `failed: ${err.message}`;
      return null;
    }
    if (!result || result.ok !== true) {
      status[f.name] = `failed: ${result?.error || 'no data'}`;
      return null;
    }
    status[f.name] = 'ok';
    return result;
  });

  const results = await runWithLimit(concurrency, tasks);

  const packet = {
    fetchers_run: fetchers.map(f => f.name),
    fetcher_status: status,
    fetched_at: new Date().toISOString(),
  };
  for (const r of results) {
    if (r && r.ok) packet[r.name] = r.data;
  }
  return packet;
}
