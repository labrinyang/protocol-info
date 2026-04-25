# Fetcher interface

Each fetcher is an ESM module that exports a default async function:

```js
export default async function fetch({ slug, displayName, hints, rootdataId, env, logger }) {
  // ... call external API ...
  return {
    name: 'rootdata',           // matches manifest fetchers[].name
    ok: true,                   // false if the fetch failed; framework still includes it
    data: { /* fetcher-shaped */ },
    cost_usd: 0,                // 0 unless the fetcher is paid + tracks
    fetched_at: '2026-04-25T...'
  };
}
```

Fetchers may also export a structured search function:

```js
export async function search({ query, type, limit = 5, env, logger }) {
  return {
    channel: 'rootdata',
    query,
    type,
    ok: true,
    results: [ /* provider-shaped */ ],
    fetched_at: '2026-04-25T...'
  };
}
```

The framework only calls `search` when a synthesis/deepening round emits an
approved `search_requests[]` entry. Search results are appended to the evidence
packet as `search_results[]`; they never overwrite record fields directly.

`env` is the process env (read-only). `logger` has `.info(msg)` and `.warn(msg)`.

A fetcher MUST NOT throw on expected failures (404, missing key, rate limit) —
return `{ok:false, data:null, error: 'reason'}`. Framework treats throws as
unhandled bugs.

Inner shape of `data` is the fetcher's choice. Keep it stable across versions
(prompts depend on the structure via manifest `evidence_keys`).
