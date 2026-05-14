# Larger Feature Proposals

Date: 2026-05-14

This plan tracks larger follow-up work after the plugin stabilization pass. The
stabilization pass handled the data-loss, schema-contract, i18n validation,
locale mapping, logo fallback, and git-locking defects. The items below are
larger product or architecture changes that should be implemented separately.

## 1. Batch i18n Across Slugs

Source issue: #9

Add first-class multi-slug i18n execution instead of relying on shell wrappers.

Proposed CLI:

```bash
./run.sh i18n --batch slug-a slug-b slug-c --locales all --parallel-slugs 4 --i18n-parallel 8
```

Acceptance criteria:

- Runs multiple slugs concurrently while preserving per-slug locale parallelism.
- Uses the existing git lock and slug preflight behavior.
- Reports per-slug success/failure and writes a batch summary.
- Does not let one failed slug roll back or block successful siblings.

## 2. Single-Field i18n Refresh

Source issues: #10, #17

Support refreshing only selected translatable fields and eventually only changed
values.

Proposed CLI:

```bash
./run.sh i18n pendle --locales zh_CN,ja_JP --fields members[].oneLiner
```

Acceptance criteria:

- Validates requested fields against `manifest.i18n.translatable_fields`.
- Extracts only requested fields for the LLM prompt.
- Deep-merges translated leaves into existing sidecars without clobbering
  unrelated translations.
- Stores source hashes per translatable leaf so later runs can skip unchanged
  cells.
- Fails closed if field-level merge would change array lengths or sibling data.

## 3. Generated i18n Schema

Source issue: #12

Generate `schemas/i18n.json` from `manifest.i18n.translatable_fields` and the
canonical full schema.

Acceptance criteria:

- Preserves canonical nullability and max length caps.
- Allows dashboard-specific stricter caps through manifest config.
- Removes hand-edit drift between manifest, schema, and prompt.
- Keeps a committed generated schema, with CI detecting stale output.

## 4. Per-Record Translation Glossary

Source issue: #13

Allow canonical records to declare inline terms that must be preserved verbatim
during translation.

Potential shape:

```json
{
  "i18nGlossary": ["Aave", "Pendle V2", "Morpho Blue"]
}
```

Acceptance criteria:

- Injects glossary terms into the i18n user prompt.
- Keeps glossary out of dashboard import payload unless explicitly supported.
- Adds validation to prevent empty strings and excessive glossary size.

## 5. Promotion Helper

Source issue: #7

Add a workflow command for lifecycle status transitions.

Proposed CLI:

```bash
./run.sh promote pendle active
```

Acceptance criteria:

- Allows only documented transitions.
- Reuses the same validation, post-processing, and commit path as `set`.
- Emits clear errors for invalid transitions.
- Documents promotion rules in README.

## 6. Bulk Dashboard Import Export

Source issue: #18

Generate flat dashboard import artifacts across many slugs.

Proposed CLI:

```bash
./run.sh export-imports --out Aimports
./run.sh export-imports --out Aimports --combined
```

Acceptance criteria:

- Copies or generates per-slug `record.import.json` files into a flat directory.
- Optionally emits one combined import JSON.
- Skips invalid or missing imports with a machine-readable report.
- Does not mutate canonical slug directories.

## 7. Recoverable i18n Debug Artifacts

Source issue: #19

Decide whether sidecars should remain gitignored or become tracked artifacts.

Recommended path:

- Keep `_debug/` ignored by default.
- Keep `restore-sidecars <slug>` as the operational recovery path.
- Add an optional archive command later if historical sidecar review becomes
  necessary.

Acceptance criteria:

- `restore-sidecars` is documented.
- Operators have a clear runbook for recovering translations from
  `record.full.json`.
- No large debug artifacts enter the normal history layer by accident.

## Suggested Order

1. Single-field i18n refresh.
2. Generated i18n schema.
3. Batch i18n across slugs.
4. Bulk dashboard import export.
5. Glossary support.
6. Promotion helper.
7. Optional sidecar archive workflow.
