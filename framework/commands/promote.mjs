import { loadRecordEnvelope } from '../record-state.mjs';
import setCmd from './set.mjs';

const ALLOWED_TRANSITIONS = {
  draft: new Set(['active', 'archived']),
  active: new Set(['archived']),
  archived: new Set(['active']),
};

const KNOWN_STATUSES = new Set(Object.keys(ALLOWED_TRANSITIONS));
const TARGET_STATUSES = new Set(['active', 'archived']);

export default async function promoteCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const [slug, target] = args;
  if (!outputRoot || !slug || !target) {
    stderr.write('Usage: protocol-info promote <slug> <active|archived>\n');
    return 1;
  }
  if (!TARGET_STATUSES.has(target)) {
    stderr.write(`promote: invalid target status "${target}"\n`);
    return 1;
  }

  let envelope;
  try {
    envelope = await loadRecordEnvelope(outputRoot, { slug });
  } catch (err) {
    stderr.write(`promote: ${err.message}\n`);
    return 1;
  }

  const current = envelope.record?.status;
  if (!KNOWN_STATUSES.has(current)) {
    stderr.write(`promote: current status "${current}" is not valid\n`);
    return 1;
  }
  if (current === target) {
    stderr.write(`promote: ${slug} is already ${target}\n`);
    return 0;
  }
  if (!ALLOWED_TRANSITIONS[current].has(target)) {
    stderr.write(`promote: invalid transition ${current} -> ${target}\n`);
    return 1;
  }

  return await setCmd([slug, 'status', JSON.stringify(target)], {
    ...ctx,
    commitMessage: `promote(${slug}): ${current} -> ${target}`,
  });
}
