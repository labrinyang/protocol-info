import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, selectEvidence } from './manifest-loader.mjs';
import { runSubtask as defaultRunSubtask } from './subtask-runner.mjs';
import { collectAuditReportEvidence, mergeAuditReportEvidence } from './audit-report-extractor.mjs';
import { resolveLLMProvider } from './llm-router.mjs';

const FRAMEWORK_DIR = dirname(fileURLToPath(import.meta.url));

function render(template, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), template);
}

async function readJsonDefault(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function runRefreshSubtask({
  slug,
  subtaskName,
  existingRecord,
  manifestPath,
  outputRoot,
  model = null,
  llmProvider = null,
  budgetLedger = null,
  budgetEnforced = false,
  env = process.env,
  runSubtask = defaultRunSubtask,
  collectAuditReports = collectAuditReportEvidence,
}) {
  const manifest = await loadManifest(manifestPath);
  const subtask = (manifest._abs.subtasks || []).find((st) => st.name === subtaskName);
  if (!subtask) {
    throw new Error(`unknown subtask "${subtaskName}"`);
  }

  const systemPrompt = await readFile(manifest._abs.system_prompt, 'utf8');
  const schemaSlice = JSON.parse(await readFile(subtask.schema_slice_abs, 'utf8'));
  const stage = `refresh:${subtaskName}`;
  const selectedProvider = resolveLLMProvider({ stage, provider: llmProvider, env });
  const promptAbs = selectedProvider === 'claude'
    ? subtask.prompt_abs
    : (subtask.evidence_prompt_abs || subtask.prompt_abs);
  const userTemplate = await readFile(promptAbs, 'utf8');
  const findingsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/findings.schema.json'), 'utf8'));
  const gapsSchema = JSON.parse(await readFile(join(FRAMEWORK_DIR, 'schemas/gaps.schema.json'), 'utf8'));
  let rootdata = await readJsonDefault(join(outputRoot, slug, '_debug', 'rootdata.json'), {});
  if (subtaskName === 'audits') {
    const auditReports = await collectAuditReports({ record: existingRecord });
    rootdata = mergeAuditReportEvidence(rootdata, auditReports);
  }
  const evidence = {
    existing_record: existingRecord,
    ...selectEvidence(rootdata, subtask.evidence_keys || []),
  };
  const userPrompt = render(userTemplate, {
    SLUG: slug,
    PROVIDER: slug,
    DISPLAY_NAME: existingRecord?.name || slug,
    HINTS: `refresh existing ${subtaskName} slice`,
    SCHEMA: JSON.stringify(schemaSlice, null, 2),
    EVIDENCE: JSON.stringify(evidence, null, 2),
  });

  const result = await runSubtask({
    subtask,
    systemPrompt,
    userPrompt,
    schemaSlice,
    findingsSchema,
    gapsSchema,
    outputKey: 'slice',
    model,
    llmProvider,
    budgetLedger,
    budgetEnforced,
    manifest,
    stage,
    env,
  });

  if (result?.ok) {
    return { ...result, changes: result.changes || [] };
  }
  return result;
}
