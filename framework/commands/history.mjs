import { log } from '../version-store.mjs';

export default async function historyCmd(args, ctx = {}) {
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const slug = args[0];
  if (!outputRoot || !slug) {
    stderr.write('Usage: protocol-info history <slug> [--limit N]\n');
    return 1;
  }

  let limit = 20;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--limit') {
      limit = parseInt(args[++i] || '', 10);
    } else {
      stderr.write(`history: unknown argument ${args[i]}\n`);
      return 1;
    }
  }
  if (!Number.isInteger(limit) || limit < 1) {
    stderr.write('history: --limit must be a positive integer\n');
    return 1;
  }

  const entries = await log(outputRoot, { slug, limit });
  for (const entry of entries) {
    stdout.write(`${entry.sha}\t${entry.ts}\t${entry.message}\t${entry.runId || ''}\n`);
  }
  return 0;
}
