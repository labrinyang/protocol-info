import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest } from '../manifest-loader.mjs';
import { seedSidecarsFromFull } from '../i18n-cache.mjs';

export default async function restoreSidecarsCmd(args, ctx = {}) {
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  const manifestPath = ctx.manifestPath;
  const [slug] = args;

  if (!outputRoot || !manifestPath || !slug) {
    stderr.write('Usage: protocol-info restore-sidecars <slug> [--overwrite]\n');
    return 1;
  }

  let overwrite = false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--overwrite') {
      overwrite = true;
    } else {
      stderr.write(`restore-sidecars: unknown argument ${args[i]}\n`);
      return 1;
    }
  }

  const slugDir = join(outputRoot, slug);
  if (!existsSync(slugDir)) {
    stderr.write(`restore-sidecars: ${slugDir} does not exist\n`);
    return 1;
  }

  const manifest = await loadManifest(manifestPath);
  const seeded = await seedSidecarsFromFull(slugDir, { manifest, overwrite });
  stdout.write(`restore-sidecars(${slug}): ${seeded.length} sidecar(s) restored${seeded.length ? `: ${seeded.join(', ')}` : ''}\n`);
  return 0;
}
