import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAt } from '../jsonpath.mjs';

export default async function getCmd(args, ctx = {}) {
  const [slug, jsonpath] = args;
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;

  if (!outputRoot || !slug || !jsonpath) {
    stderr.write('Usage: protocol-info get <slug> <jsonpath>\n');
    return 1;
  }

  let record;
  try {
    record = JSON.parse(await readFile(join(outputRoot, slug, 'record.json'), 'utf8'));
  } catch (err) {
    stderr.write(`get: unable to read ${join(outputRoot, slug, 'record.json')}: ${err.message}\n`);
    return 1;
  }

  try {
    stdout.write(JSON.stringify(getAt(record, jsonpath), null, 2) + '\n');
    return 0;
  } catch (err) {
    stderr.write(`get: ${err.message}\n`);
    return 1;
  }
}
