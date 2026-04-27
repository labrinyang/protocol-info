import { diff } from '../version-store.mjs';

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

  const fromSha = sha1Arg || 'HEAD~1';
  const toSha = sha2Arg || 'HEAD';
  const body = await diff(outputRoot, { slug, fromSha, toSha });
  stdout.write(body);
  return 0;
}
