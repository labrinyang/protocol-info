import { diff, log } from '../version-store.mjs';

export default async function diffCmd(args, ctx = {}) {
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const [slug, sha1Arg, sha2Arg] = args;
  if (!outputRoot || !slug) {
    stderr.write('Usage: protocol-info diff <slug> [from] [to]\n');
    return 1;
  }
  if (args.length > 3) {
    stderr.write('diff: too many arguments\n');
    return 1;
  }

  let fromSha = sha1Arg;
  let toSha = sha2Arg;
  if (!fromSha && !toSha) {
    const entries = await log(outputRoot, { slug, limit: 2 });
    if (entries.length < 2) {
      stderr.write(`diff: ${slug} needs at least two commits; pass <from> <to> explicitly\n`);
      return 1;
    }
    [toSha, fromSha] = [entries[0].sha, entries[1].sha];
  } else if (fromSha && !toSha) {
    toSha = 'HEAD';
  }
  const body = await diff(outputRoot, { slug, fromSha, toSha });
  stdout.write(body);
  return 0;
}
