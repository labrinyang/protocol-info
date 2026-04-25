// Bounded promise queue. Replaces the bash `wait "${pids[0]}"` pattern.
// runWithLimit(n, tasks, opts?) — tasks is an array of () => Promise<T>.
// Returns Promise<T[]> in input order. With opts.collectErrors=true, returns
// Array<{ok:true,value} | {ok:false,error}> instead of throwing.

export async function runWithLimit(limit, tasks, opts = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`runWithLimit: limit must be positive integer, got ${limit}`);
  }
  const results = new Array(tasks.length);
  let next = 0;
  const collectErrors = !!opts.collectErrors;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      try {
        const v = await tasks[idx]();
        results[idx] = collectErrors ? { ok: true, value: v } : v;
      } catch (err) {
        if (collectErrors) {
          results[idx] = { ok: false, error: err };
        } else {
          throw err;
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
