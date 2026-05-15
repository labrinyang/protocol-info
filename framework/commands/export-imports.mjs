import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function parseArgs(args) {
  const opts = {
    out: 'Aimports',
    combined: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out') {
      opts.out = args[++i] || '';
    } else if (arg === '--combined') {
      opts.combined = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!opts.out) throw new Error('--out requires a directory');
  return opts;
}

function outputDirFor(outputRoot, outArg) {
  if (outArg.startsWith('/')) return outArg;
  return resolve(outputRoot, outArg);
}

async function listSlugDirs(outputRoot, exportDir) {
  const entries = await readdir(outputRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && resolve(outputRoot, name) !== exportDir)
    .sort();
}

function validateImportEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a JSON object';
  if (!Array.isArray(value.data)) return 'missing data array';
  return null;
}

export default async function exportImportsCmd(args, ctx = {}) {
  const stderr = ctx.stderr || process.stderr;
  const outputRoot = ctx.outputRoot;
  if (!outputRoot) {
    stderr.write('Usage: protocol-info export-imports --out <dir> [--combined]\n');
    return 1;
  }

  let opts;
  try {
    opts = parseArgs(args);
  } catch (err) {
    stderr.write(`export-imports: ${err.message}\n`);
    return 1;
  }

  const manifest = ctx.manifest || {};
  const importFilename = manifest.output?.import_filename || 'record.import.json';
  const exportDir = outputDirFor(outputRoot, opts.out);
  await mkdir(exportDir, { recursive: true });

  const copied = [];
  const missing = [];
  const invalid = [];
  const combinedData = [];

  for (const slug of await listSlugDirs(outputRoot, exportDir)) {
    const source = join(outputRoot, slug, importFilename);
    if (!existsSync(source)) {
      missing.push({ slug, path: source });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(source, 'utf8'));
    } catch (err) {
      invalid.push({ slug, path: source, error: err.message });
      continue;
    }
    const validationError = validateImportEnvelope(parsed);
    if (validationError) {
      invalid.push({ slug, path: source, error: validationError });
      continue;
    }
    const target = join(exportDir, `${slug}.json`);
    await copyFile(source, target);
    copied.push({ slug, path: target, rows: parsed.data.length });
    if (opts.combined) combinedData.push(...parsed.data);
  }

  const report = {
    exportedAt: new Date().toISOString(),
    outputDir: exportDir,
    copied,
    missing,
    invalid,
  };

  if (opts.combined) {
    const combined = {
      version: '1.0',
      exportedAt: report.exportedAt,
      data: combinedData,
    };
    const combinedPath = join(exportDir, 'combined.import.json');
    await writeFile(combinedPath, JSON.stringify(combined, null, 2) + '\n');
    report.combined = { path: combinedPath, rows: combinedData.length };
  }

  const reportPath = join(exportDir, 'export-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  stderr.write(`export-imports: copied ${copied.length}; missing ${missing.length}; invalid ${invalid.length}; report: ${reportPath}\n`);
  return 0;
}
