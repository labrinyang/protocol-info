// Bounded promise queue. Replaces the bash `wait "${pids[0]}"` pattern.
// runWithLimit(n, tasks, opts?) — tasks is an array of () => Promise<T>.
// Returns Promise<T[]> in input order. With opts.collectErrors=true, returns
// Array<{ok:true,value} | {ok:false,error}> instead of throwing.
//
// Without collectErrors, the first thrown task rejects the overall promise
// and prevents further tasks from being picked up. In-flight tasks complete
// naturally (you cannot cancel an in-progress await), but their results are
// discarded. Use collectErrors:true if you want every task to run regardless
// of sibling failures.

export async function runWithLimit(limit, tasks, opts = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`runWithLimit: limit must be positive integer, got ${limit}`);
  }
  const results = new Array(tasks.length);
  let next = 0;
  let failed = false;
  const collectErrors = !!opts.collectErrors;

  async function worker() {
    while (!failed) {
      const idx = next++;
      if (idx >= tasks.length) return;
      try {
        const v = await tasks[idx]();
        results[idx] = collectErrors ? { ok: true, value: v } : v;
      } catch (err) {
        if (collectErrors) {
          results[idx] = { ok: false, error: err };
        } else {
          failed = true;
          throw err;
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
