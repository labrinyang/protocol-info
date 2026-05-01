import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export function r1EnvelopePath(debugDir, subtaskName) {
  return join(debugDir, `${subtaskName}.envelope.json`);
}

export async function clearStaleR1Envelopes(debugDir, subtasks = []) {
  const names = Array.from(new Set(
    (subtasks || [])
      .map((st) => st?.name)
      .filter((name) => typeof name === 'string' && name.trim())
  ));
  await Promise.all(names.map((name) => rm(r1EnvelopePath(debugDir, name), { force: true })));
}
