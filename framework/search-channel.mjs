// Executes model-emitted search_requests through fetcher.search() exports.
// Caps total queries by maxQueries and silently drops any channel that does
// not match a known fetcher. Each result is tagged with {round, reason} so
// downstream evidence appenders can attribute the hit.

export async function runSearchRequests({ requests, fetchers, maxQueries, env, logger, round }) {
  const byName = new Map(fetchers.map(f => [f.name, f]));
  const out = [];
  for (const req of (requests || []).slice(0, maxQueries)) {
    const f = byName.get(req.channel);
    if (!f || typeof f.search !== 'function') {
      logger?.warn?.(`[search] skipped unknown channel ${req.channel}`);
      continue;
    }
    let result;
    try {
      result = await f.search({ query: req.query, type: req.type, limit: req.limit || 5, env, logger });
    } catch (err) {
      logger?.warn?.(`[search] ${req.channel} threw: ${err.message || err}`);
      result = { channel: req.channel, query: req.query, ok: false, error: String(err.message || err), results: [] };
    }
    out.push({ round, reason: req.reason || '', ...result });
  }
  return out;
}
