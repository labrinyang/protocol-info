// DeFiLlama fetcher. Free public API, no key required.
// Steps:
//   1. fetch /protocols (list) once, cache for the process
//   2. fuzzy-match displayName → slug
//   3. fetch /protocol/<slug> for TVL, chains, category
//   4. shape into evidence packet subtree
//
// Capture global fetch before our default export shadows the identifier
// inside this module's scope (same pattern as rootdata.mjs).

const httpFetch = globalThis.fetch;
const API = 'https://api.llama.fi';

let _listCache = null;
async function fetchProtocolList(logger) {
  if (_listCache) return _listCache;
  const res = await httpFetch(`${API}/protocols`, { headers: { 'User-Agent': 'protocol-info/1.0' } });
  if (!res.ok) throw new Error(`defillama /protocols ${res.status}`);
  _listCache = await res.json();
  return _listCache;
}

export function matchProtocol(list, displayName) {
  const target = displayName.trim().toLowerCase();
  // 1. exact name match
  const exact = list.find(p => (p.name || '').toLowerCase() === target);
  if (exact) return exact;
  // 2. prefix match, sorted by TVL desc
  const prefix = list
    .filter(p => (p.name || '').toLowerCase().startsWith(target))
    .sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
  if (prefix.length) return prefix[0];
  return null;
}

export default async function fetch({ slug, displayName, hints, env, logger }) {
  try {
    const list = await fetchProtocolList(logger);
    const matched = matchProtocol(list, displayName);
    if (!matched) {
      return {
        name: 'defillama', ok: false, data: null,
        error: `no DeFiLlama protocol matches "${displayName}"`,
        cost_usd: 0, fetched_at: new Date().toISOString(),
      };
    }
    const detailRes = await httpFetch(`${API}/protocol/${matched.slug}`, { headers: { 'User-Agent': 'protocol-info/1.0' } });
    if (!detailRes.ok) throw new Error(`defillama /protocol/${matched.slug} ${detailRes.status}`);
    const detail = await detailRes.json();
    return {
      name: 'defillama',
      ok: true,
      data: {
        defillama_slug: matched.slug,
        tvl_usd: matched.tvl ?? null,
        category: detail.category ?? null,
        chains: detail.chains ?? [],
        listed_at: detail.listedAt ?? null,
        twitter: detail.twitter ?? null,
        url: detail.url ?? null,
      },
      cost_usd: 0,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    logger?.warn?.(`defillama fetch failed: ${err.message}`);
    return {
      name: 'defillama', ok: false, data: null, error: err.message,
      cost_usd: 0, fetched_at: new Date().toISOString(),
    };
  }
}
