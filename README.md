# protocol-info

English | [简体中文](README.zh-CN.md)

`protocol-info` is a Claude Code plugin and standalone CLI for researching DeFi earn/yield/staking protocols and producing schema-validated `EarnProtocolInfo` JSON.

It runs Claude in headless mode, gathers structured evidence from optional fetchers such as RootData and DeFiLlama, reconciles field-level evidence, validates the final record against JSON Schema, and can optionally translate selected fields with Haiku for 19 locales.

The output is intended for human review first, then import into the dashboard through the `earn-protocol-info` import endpoint.

## When To Use It

Use this project when you need a repeatable research pipeline for protocol metadata:

- Protocol description, tags, official website, X, and Discord links
- Founding year
- Public team members, roles, social links, and short bios
- Funding rounds with investors, amount, valuation, and dates
- Audit reports with auditor, scope, report URL, and scan timestamp
- Field-level findings, unresolved gaps, and R2 change audit trail
- Optional localized output for the dashboard import flow

It is not a fully automated publishing system. The crawler produces reviewable records; a human should still verify team, funding, and audit data before promoting records in production.

## Install As A Claude Code Plugin

Recommended installation:

```text
/plugin marketplace add labrinyang/protocol-info
/plugin install protocol-info@labrinyang
```

Optional RootData configuration:

```bash
mkdir -p ~/.config/protocol-info
echo "ROOTDATA_API_KEY=sk-..." > ~/.config/protocol-info/.env
chmod 600 ~/.config/protocol-info/.env
```

This user config path is outside the plugin cache, so plugin updates will not overwrite it. Without `ROOTDATA_API_KEY`, the pipeline still works and simply skips RootData-backed evidence.

After installation, you can call the slash command directly:

```text
/protocol-info:protocol-info --display-name "Pendle" --type fixed_rate
/protocol-info:protocol-info --display-name "Pendle" --type fixed_rate --i18n all
/protocol-info:protocol-info --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" --type fixed_rate \
  --batch --display-name "Morpho" --type simple_earn
```

You can also trigger the bundled skill with natural language, for example:

- "Research Pendle protocol info and translate it into Chinese and Japanese."
- "Batch crawl Morpho and Aave earn metadata without translation."
- "Create protocol-info for Lido." The skill may ask one short question if the protocol type is ambiguous.
- "Crawl protocol info for Morpho and translate to all locales."

The skill lives at `skills/protocol-info-crawler/SKILL.md` and dispatches to `/protocol-info:protocol-info`.

## Use As A Standalone CLI

Clone the repository and run the shim:

```bash
./run.sh --display-name "Pendle" --type fixed_rate
```

`run.sh` only loads environment variables and delegates to `framework/cli.mjs`. It looks for environment files in this order:

1. `<repo>/.env`
2. `~/.config/protocol-info/.env`

Required local tools:

| Tool | Purpose |
| --- | --- |
| `claude` CLI | Headless Claude calls |
| `node` >= 18 | Pipeline runtime |

## Common Commands

Single protocol:

```bash
./run.sh --display-name "f(x)Protocol" --type simple_earn
```

Specify slug, RootData ID, or research hints:

```bash
./run.sh --display-name "Pendle" --type fixed_rate \
  --slug pendle \
  --rootdata-id 874 \
  --hints "Yield trading protocol with PT/YT markets"
```

Batch run:

```bash
./run.sh --parallel 4 \
  --batch --display-name "Pendle" --type fixed_rate \
  --batch --display-name "Morpho" --type simple_earn \
  --batch --display-name "Aave" --type simple_earn
```

i18n:

```bash
./run.sh --display-name "Pendle" --type fixed_rate --i18n all
./run.sh --display-name "Pendle" --type fixed_rate --i18n zh_CN,ja_JP,en_US
./run.sh --display-name "Pendle" --type fixed_rate --i18n none
```

Dry run:

```bash
./run.sh --dry-run --display-name "Pendle" --type fixed_rate
```

## CLI Flags

| Flag | Required | Description |
| --- | --- | --- |
| `--display-name <name>` | Yes | Protocol display name. |
| `--type <type>` | No, recommended | One of `fixed_rate`, `simple_earn`, `staking`. If omitted, the metadata subtask tries to infer it. |
| `--slug <slug>` | No | Business key. Defaults to a slugified display name. |
| `--hints <text>` | No | Extra research context passed to Claude. |
| `--rootdata-id <int>` | No | RootData project ID. If omitted, the fetcher searches by name when `ROOTDATA_API_KEY` is set. |
| `--batch` | No | Flushes the current provider and starts another one. |
| `--model <name>` | No | Override model for R1 and R2. |
| `--max-turns <n>` | No | Per-Claude-call turn cap; clamps manifest defaults down. |
| `--max-budget <usd>` | No | Total single-provider LLM budget cap. The orchestrator splits it across R1, R2, and i18n. |
| `--parallel <n>` | No | Number of providers to run concurrently. Default: `1`. |
| `--i18n <flag>` | No | `none`, `all`, or comma-separated locale codes such as `zh_CN,ja_JP`. Empty means silent skip. |
| `--i18n-parallel <n>` | No | Locale translation concurrency. Default: `8`. |
| `--i18n-model <name>` | No | Override i18n model. Manifest default: `claude-haiku-4-5-20251001`. |
| `--dry-run` | No | Print resolved providers and stop. Forces `--parallel 1`. |
| `--manifest <path>` | No | Advanced: run a different consumer manifest. |

## Output Layout

Each protocol run writes artifacts under:

```text
out/<slug>/<run-id>/
```

Batch-level indexes are written under:

```text
out/_runs/<run-id>/
```

Typical files:

| File | Purpose |
| --- | --- |
| `record.json` | Source-language `EarnProtocolInfo` record that passed schema validation. |
| `record.full.json` | Inline i18n version, present only when translations were generated. |
| `record.import.json` | Dashboard import envelope: `{ version, exportedAt, data: [...] }`. `sources` is stripped. |
| `findings.json` | Field-level evidence with source URLs and confidence. |
| `gaps.json` | Unresolved or weak fields, including attempted search paths. |
| `changes.json` | R2 reconciliation changes and reasons. |
| `meta.json` | Run status, RootData usage, budget plan, R1/R2 telemetry, i18n status. |
| `summary.tsv` | Per-protocol summary row. |
| `_debug/` | Raw envelopes, stderr logs, intermediate evidence, i18n sidecars. |

The batch summary is:

```text
out/_runs/<run-id>/summary.tsv
```

## Pipeline

```text
R0 fetch
  RootData + DeFiLlama evidence
        |
        v
R1 fan-out
  metadata / team / funding / audits
        |
        v
Merge slices + evidence diff
        |
        v
R2 audit-first reconcile
  optional RootData search channel
        |
        v
Normalize + schema validate
        |
        v
Optional i18n
        |
        v
Post-process dashboard export
```

### R0 fetch

Fetchers gather structured evidence before Claude synthesis. RootData requires `ROOTDATA_API_KEY`; DeFiLlama is keyless. Missing optional fetchers do not fail the run.

### R1 fan-out

Four independent Claude subtasks run against schema slices:

- `metadata`
- `team`
- `funding`
- `audits`

Each subtask returns:

```json
{
  "slice": {},
  "findings": [],
  "gaps": [],
  "handoff_notes": []
}
```

### R2 reconcile

R2 merges R1 slices and evidence with an audit-first policy:

- High-confidence R1 fields are not overwritten by uncited R2 changes.
- R2 can add missing fields when it has cited evidence.
- Search requests are limited and routed through approved fetcher search channels.
- Every accepted change is recorded in `changes.json`.

### Normalize And Validate

Consumer normalizers apply deterministic fixes, such as `audits.lastScannedAt`. The final `record.json` must pass `consumers/protocol-info/schemas/full.json`.

### i18n And Export

If `--i18n` is set, Haiku translates configured fields from the manifest:

- `description`
- `members[].memberPosition`
- `members[].oneLiner`

Then post-processing writes:

- `record.full.json` for inline preview
- `record.import.json` for dashboard import

## Schema Summary

The main schema is `consumers/protocol-info/schemas/full.json`.

Top-level fields:

```json
{
  "slug": "pendle",
  "provider": "pendle",
  "displayName": "Pendle",
  "type": "fixed_rate",
  "description": "...",
  "tags": ["yield", "fixed-rate"],
  "establishment": 2021,
  "members": [],
  "providerWebsite": "https://...",
  "providerXLink": "https://...",
  "providerDiscordLink": null,
  "status": "draft",
  "fundingRounds": [],
  "audits": {
    "items": [],
    "lastScannedAt": "2026-04-27"
  },
  "sources": ["https://..."]
}
```

Important constraints:

- `type`: `fixed_rate`, `simple_earn`, or `staking`
- `status`: crawler output should be `draft`
- `members`: at least one entry
- `fundingRounds`: full funding history, newest first
- `audits.items[].date`: `YYYY-MM` or `YYYY-MM-DD`; bare years are invalid
- URL fields must be absolute URIs or `null` when nullable
- `sources` is an audit trail and is stripped from `record.import.json`

## Supported Locales

| Code | Language |
| --- | --- |
| `bn` | Bengali |
| `de` | German |
| `en_US` | English (US) |
| `es` | Spanish |
| `fr_FR` | French |
| `hi_IN` | Hindi |
| `id` | Indonesian |
| `it_IT` | Italian |
| `ja_JP` | Japanese |
| `ko_KR` | Korean |
| `pt` | Portuguese |
| `pt_BR` | Portuguese (Brazil) |
| `ru` | Russian |
| `th_TH` | Thai |
| `uk_UA` | Ukrainian |
| `vi` | Vietnamese |
| `zh_CN` | Simplified Chinese |
| `zh_HK` | Traditional Chinese (Hong Kong) |
| `zh_TW` | Traditional Chinese (Taiwan) |

## Review And Import

Recommended review flow:

1. Open `out/_runs/<run-id>/summary.tsv`.
2. For each `OK` row, review `out/<slug>/<run-id>/record.json`.
3. Check `findings.json` for source coverage.
4. Check `gaps.json` for missing or weak fields.
5. Check `changes.json` when R2 changed R1 output.
6. Import `record.import.json` after review.

Example import:

```bash
curl -X POST "$DASHBOARD/api/earn-protocol-info/import" \
  -H "Content-Type: application/json" \
  -d @out/<slug>/<run-id>/record.import.json
```

Even without i18n, `record.import.json` contains one source-language record with dashboard locale `en`.

## Troubleshooting

### `claude CLI not found`

Install Claude Code and ensure `claude` is on `PATH`, or set `CLAUDE_BIN`:

```bash
CLAUDE_BIN=/path/to/claude ./run.sh --display-name "Pendle" --type fixed_rate
```

### RootData is disabled

Set `ROOTDATA_API_KEY` in either `<repo>/.env` or `~/.config/protocol-info/.env`. Without it, RootData fetch and search channels are skipped.

### `SCHEMA_FAIL`

Open the protocol directory and inspect:

- `record.json`
- `gaps.json`
- `changes.json`
- `_debug/schema.stderr.log` if present

Common causes are invalid URLs, missing required members, incomplete dates, or audit dates with bare years.

### Partial i18n success

The summary column may show values such as `3/19`. Inspect:

```text
out/<slug>/<run-id>/_debug/i18n/
```

Successful locale sidecars are still used by post-processing.

### Output path changed

The current layout is protocol-first:

```text
out/<slug>/<run-id>/
out/_runs/<run-id>/summary.tsv
```

Older docs or generated paths using `out/<run-id>/<slug>/` are stale.

## Development

Run all local checks:

```bash
node scripts/check-all.mjs
```

Validate the Claude Code plugin:

```bash
claude plugin validate .
```

The framework is intentionally consumer-oriented. To add another consumer, provide a manifest, full schema, slice schemas, prompts, and optional fetchers, normalizers, and post-processing modules. The shared framework handles scheduling, budget splitting, evidence merging, validation, i18n, and summaries.
