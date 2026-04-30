# protocol-info

English | [简体中文](README.zh-CN.md)

`protocol-info` is a Claude Code plugin and standalone CLI for researching DeFi earn/yield/staking protocols and producing schema-validated `EarnProtocolInfo` JSON.

It runs Claude in headless mode, gathers structured evidence from optional fetchers such as RootData and DeFiLlama, reconciles field-level evidence, validates the final record against JSON Schema, rehosts protocol/member/auditor logos into stable output folders, and can optionally translate selected fields with Claude Haiku or an OpenAI-compatible gateway for 19 locales.

The output is intended for human review first, then import into the dashboard through the `earn-protocol-info` import endpoint.

By default, generated artifacts are written to `out/` under the current working
directory where the command is invoked. Plugin updates do not move the output
root because it is not tied to the plugin cache path.

## When To Use It

Use this project when you need a repeatable research pipeline for protocol metadata:

- Protocol description, tags, official website, X, and Discord links
- Founding year
- Public team members, roles, social links, and short bios
- Funding rounds with investors, amount, valuation, and dates
- Audit reports with auditor, scope, report URL, and scan timestamp
- Provider, team member, and auditor logo URLs rewritten to stable OneKey CDN paths
- Field-level findings, unresolved gaps, and R2 change audit trail
- Optional localized output for the dashboard import flow

It is not a fully automated publishing system. The crawler produces reviewable records; a human should still verify team, funding, and audit data before promoting records in production.

## Install As A Claude Code Plugin

Recommended installation:

```text
/plugin marketplace add labrinyang/protocol-info
/plugin install protocol-info@labrinyang
```

Optional runtime configuration lives in `~/.config/protocol-info/.env` or
`<repo>/.env`. Already-exported shell variables win; `.env` only fills missing
values.

RootData key lookup order:

1. `--rootdata-key <key>` CLI flag (one-shot; never written to disk)
2. `ROOTDATA_API_KEY` exported in the calling shell
3. `~/.config/protocol-info/.env` (recommended for plugin users — survives plugin updates)
4. `<repo>/.env` (standalone CLI only; ignored when installed via the plugin cache)

Persist a key for the plugin install:

```bash
mkdir -p ~/.config/protocol-info
echo "ROOTDATA_API_KEY=sk-..." > ~/.config/protocol-info/.env
chmod 600 ~/.config/protocol-info/.env
```

Or use it once without writing a file:

```bash
/protocol-info:protocol-info --rootdata-key sk-... --display-name "Pendle"
```

The startup banner reports which source the key came from (`shell-env`, `--rootdata-key`, or the resolved `.env` path). Without `ROOTDATA_API_KEY`, the pipeline still works and simply skips RootData-backed evidence.

Paid Unavatar key for member/auditor avatar rehosting:

```bash
UNAVATAR_API_KEY=sk-...
```

`UNAVATAR_API_KEY` follows the same shell / `~/.config/protocol-info/.env` /
`<repo>/.env` precedence as RootData. You can also pass
`--unavatar-key <key>` for one run. Without it, the pipeline can still try
Unavatar anonymously, but may hit public rate limits.

Optional OpenAI-compatible LLM gateway for no-web stages:

```bash
I18N_PROVIDER=openai
OPENAI_BASE_URL=https://llm.example.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
# Optional, enables cost accounting and --max-budget for external routes:
OPENAI_INPUT_COST_PER_1M=1.25
OPENAI_OUTPUT_COST_PER_1M=10
```

OpenAI-compatible config uses the same precedence model as RootData:

1. One-shot CLI flags: `--openai-api-key`, `--openai-base-url`, `--openai-model`, `--openai-input-cost-per-1m`, `--openai-output-cost-per-1m`
2. Already-exported shell variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, pricing vars
3. `~/.config/protocol-info/.env` (recommended for plugin users)
4. `<repo>/.env` (standalone CLI only)

Example one-shot run:

```bash
./run.sh --openai-api-key sk-... \
  --openai-base-url https://llm.example.com/v1 \
  --openai-model gpt-5.5 \
  --i18n all \
  --display-name "Pendle"
```

`i18n` is the safest default external-LLM use. R2 and field analysis can also
opt in with `R2_LLM_PROVIDER=openai` or `ANALYZE_LLM_PROVIDER=openai`; they use
existing evidence and approved search channels, not Claude WebFetch/WebSearch.
For R2, `R2_LLM_PROVIDER=openai` uses the evidence-only reconcile prompt.
`--r2-routing external_first` or `R2_ROUTING=external_first` runs an external
evidence-only R2 and fails closed when the deterministic gate rejects the
result. `--r2-routing external_first_with_claude_fallback` or
`R2_ROUTING=external_first_with_claude_fallback` runs the same external pass
first, then falls back to Claude web reconcile when the gate rejects the result.
`REFRESH_AUDITS_LLM_PROVIDER=openai` is also allowed because audit report text
is extracted deterministically before the model call and the refresh uses an
evidence-only audits prompt. R1 and other refresh subtasks stay on Claude by
policy unless the manifest explicitly opts them in.
OpenAI-compatible gateway calls report `cost_usd: null` until pricing env vars
are configured; with pricing, external routes can participate in `--max-budget`
accounting. The startup banner reports OpenAI-compatible key/base/model/pricing
sources without printing the API key.

After installation, you can call the slash command directly:

```text
/protocol-info:protocol-info --display-name "Pendle"
/protocol-info:protocol-info --display-name "Pendle" --i18n all
/protocol-info:protocol-info --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" \
  --batch --display-name "Morpho"
```

You can also trigger the bundled skill with natural language, for example:

- "Research Pendle protocol info and translate it into Chinese and Japanese."
- "Batch crawl Morpho and Aave earn metadata without translation."
- "Create protocol-info for Lido."
- "Crawl protocol info for Morpho and translate to all locales."
- "Translate the existing Pendle record into Japanese."
- "Verify Pendle fundingRounds and apply the update."

The skill lives at `skills/protocol-info-crawler/SKILL.md` and dispatches to `/protocol-info:protocol-info`.

## Use As A Standalone CLI

Clone the repository and run the shim:

```bash
./run.sh --display-name "Pendle"
```

`run.sh` only loads environment variables and delegates to `framework/cli.mjs`. It fills missing environment variables in this order:

1. Already-exported shell environment variables
2. `~/.config/protocol-info/.env`
3. `<repo>/.env`

Required local tools:

| Tool | Purpose |
| --- | --- |
| `claude` CLI | Headless Claude calls |
| `node` >= 18 | Pipeline runtime |

## Common Commands

Single protocol:

```bash
./run.sh --display-name "f(x)Protocol"
```

Specify slug, RootData ID, or research hints:

```bash
./run.sh --display-name "Pendle" \
  --slug pendle \
  --rootdata-id 874 \
  --hints "Yield trading protocol with PT/YT markets"
```

Batch run:

```bash
./run.sh --parallel 4 \
  --batch --display-name "Pendle" \
  --batch --display-name "Morpho" \
  --batch --display-name "Aave"
```

i18n:

```bash
./run.sh --display-name "Pendle" --i18n all
./run.sh --display-name "Pendle" --i18n zh_CN,ja_JP,en_US
./run.sh --display-name "Pendle" --i18n none
```

OpenAI-compatible no-web routes:

```bash
I18N_PROVIDER=openai ./run.sh --display-name "Pendle" --i18n all
R2_ROUTING=external_first_with_claude_fallback ./run.sh --display-name "Pendle"
R2_LLM_PROVIDER=openai ./run.sh --display-name "Pendle"
```

Workflow commands on an existing `out/<slug>/`:

```bash
./run.sh get pendle description
./run.sh set pendle description '"Updated source-language description"'
./run.sh analyze pendle fundingRounds --query "verify latest funding rounds"
./run.sh analyze pendle fundingRounds --query "verify latest funding rounds" --llm-provider openai --apply
./run.sh i18n pendle --locales zh_CN,ja_JP
./run.sh refresh pendle audits --llm-provider openai
./run.sh history pendle
./run.sh diff pendle
./run.sh restore pendle <sha>
```

Write commands normalize deterministic fields, validate the full record,
invalidate stale i18n artifacts when source fields change, run post-processing
so `record.import.json` stays aligned, create one scoped local git commit in
`out/`, and refresh `out/index.html`. `analyze` without `--apply` is
proposal-only and writes nothing. Workflow commands can use one-shot
`--openai-*` config flags; `analyze` and `refresh` also accept
`--llm-provider openai`. External refresh is policy-allowed for `audits`; other
refresh subtasks stay on Claude unless the manifest opts them in.

Dry run:

```bash
./run.sh --dry-run --display-name "Pendle"
```

## CLI Flags

| Flag | Required | Description |
| --- | --- | --- |
| `--display-name <name>` | Yes | Protocol display name. |
| `--slug <slug>` | No | Business key. Defaults to a slugified display name. |
| `--hints <text>` | No | Extra research context passed to Claude. |
| `--rootdata-id <int>` | No | RootData project ID. If omitted, the fetcher searches by name when `ROOTDATA_API_KEY` is set. |
| `--batch` | No | Flushes the current provider and starts another one. |
| `--model <name>` | No | Override model for R1 and R2. Manifest default: `claude-sonnet-4-6`. |
| `--rootdata-key <key>` | No | RootData API key for this run; overrides shell env and `.env` files. Never persisted. |
| `--unavatar-key <key>` | No | Paid Unavatar API key for this run; overrides shell env and `.env` files. Never persisted. |
| `--openai-api-key <key>` | No | OpenAI-compatible API key for this run; overrides shell env and `.env` files. Never persisted. |
| `--openai-base-url <url>` | No | OpenAI-compatible base URL for this run. |
| `--openai-model <name>` | No | Model for OpenAI-compatible i18n/R2/analyze/refresh routes. |
| `--openai-input-cost-per-1m <usd>` | No | External input-token price per 1M tokens, used for cost reporting and `--max-budget`. |
| `--openai-output-cost-per-1m <usd>` | No | External output-token price per 1M tokens, used for cost reporting and `--max-budget`. |
| `--max-turns <n>` | No | Per-Claude-call turn cap; clamps manifest defaults down. |
| `--max-budget <usd>` | No | Total single-provider LLM budget cap. The orchestrator splits it across R1, R2, and i18n. |
| `--r2-routing <mode>` | No | R2 route. Default `single_provider`; `external_first` tries OpenAI-compatible evidence reconcile and fails closed on gate rejection; `external_first_with_claude_fallback` falls back to Claude web reconcile. |
| `--parallel <n>` | No | Number of providers to run concurrently. Default: `1`. |
| `--i18n <flag>` | No | `none`, `all`, or comma-separated locale codes such as `zh_CN,ja_JP`. Empty means silent skip. |
| `--i18n-parallel <n>` | No | Locale translation concurrency. Default: `8`. |
| `--i18n-model <name>` | No | Override i18n model. Manifest default: `claude-haiku-4-5-20251001`. |
| `--dry-run` | No | Print resolved providers and stop. Forces `--parallel 1`. |
| `--force-overwrite` | No | Overwrite a protocol directory that has uncommitted edits. Without this, v2 refuses to clobber manual changes. |
| `--manifest <path>` | No | Advanced: run a different consumer manifest. |

`record.type` is not a CLI input. The metadata subtask infers it from evidence.

## Workflow Commands

These commands operate on the canonical `out/<slug>/record.json` created by a
previous crawl. They do not create a second displayed copy of the protocol;
history and rollback are handled by the nested git repo under `out/`.

| Command | Writes? | Purpose |
| --- | --- | --- |
| `get <slug> <jsonpath>` | No | Print one value as JSON. |
| `set <slug> <jsonpath> <json>` | Yes | Manually replace one value, validate, post-process, commit. |
| `analyze <slug> <jsonpath> --query <text>` | No | Research one field and print a proposed value with evidence. |
| `analyze <slug> <jsonpath> --query <text> --apply` | Yes | Apply the proposal at the same path, validate, post-process, commit. |
| `i18n <slug> [--locales LIST]` | Yes | Re-run translation sidecars and export files from the current record. |
| `refresh <slug> <metadata|team|funding|audits>` | Yes | Re-run one broad R1 subtask and merge through the audit-first guard. |
| `history <slug> [--limit N]` | No | Show local git history for one protocol. |
| `diff <slug> [from] [to]` | No | Show a unified diff for one protocol. With no refs, compares that slug's latest two commits. |
| `restore <slug> <sha>` | Yes | Restore a previous valid version, post-process, commit. |

## Output Layout

Each protocol writes its canonical artifacts under:

```text
out/<slug>/
```

`out/` is a local git repo. Each successful crawl creates one commit for the
changed protocol directories, with the batch run id stored as a `Run-Id:` git
trailer. Batch scratch files are written under:

```text
out/.runs/<run-id>/
```

Every completed run also refreshes:

```text
out/index.html
```

`out/index.html` is a self-contained local review console for the output tree. Open it directly in a browser to filter protocols, inspect artifacts, review per-protocol changes, check logo asset coverage, copy workflow commands, and copy one merged import JSON for the visible records. Its detail pane has four modes:

- `Artifacts` — preview/copy `record.json`, `record.import.json`, `record.full.json`, findings, gaps, changes, and meta files.
- `Changes` — view the slug-scoped local git history plus the latest diff stats and unified diff.
- `Assets` — inspect provider, member, and audit logo assets, including whether the local file exists under the uploadable logo folders.
- `Commands` — copy common `get`, `set`, `analyze`, `i18n`, `refresh`, `history`, `diff`, and `restore` commands for the selected protocol.

It embeds only review artifacts; raw Claude/debug logs stay under `_debug/`.

![out/index.html — protocol review console with artifacts, changes, assets, commands, and run filters](docs/images/out-browser.png)

Typical files:

| File | Purpose |
| --- | --- |
| `../index.html` | Static local browser for reviewing protocol artifacts, history, commit diffs, and copying key outputs. |
| `record.json` | Source-language `EarnProtocolInfo` record that passed schema validation. Review/audit file, not the dashboard import envelope. |
| `record.full.json` | Inline i18n version, present only when translations were generated. |
| `record.import.json` | Dashboard import envelope: `{ version, exportedAt, data: [...] }`. Use this for import. `sources` is stripped. |
| `findings.json` | Field-level evidence with source URLs and confidence. |
| `gaps.json` | Unresolved or weak fields, including attempted search paths. |
| `changes.json` | R2 reconciliation changes and reasons. |
| `meta.json` | Run status, RootData usage, budget plan, R1/R2 telemetry, i18n status. |
| `summary.tsv` | Per-protocol generated summary row for the local browser. Gitignored. |
| `_debug/` | Raw envelopes, stderr logs, intermediate evidence, i18n sidecars. |
| `../protocol-logo/` | Provider/protocol logos referenced by `providerLogoUrl`. Upload this folder to `/static/logo/protocol-logo/`. |
| `../protocol-member-logo/` | Team member logos referenced by `members[].avatarUrl`. Upload this folder to `/static/logo/protocol-member-logo/`. |
| `../audit-logo/` | Auditor logos referenced by `audits.items[].auditorLogoUrl`. Upload this folder to `/static/logo/audit-logo/`. |

The batch summary is:

```text
out/.runs/<run-id>/summary.tsv
```

### Upgrading from 1.x

v2.0 changed the output layout from `out/<runId>/<slug>/` to `out/<slug>/`, and `out/` is now a local git repo (`out/.git/`). Each successful crawl is one commit; `out/.runs.log` tracks batch metadata.

If you have existing v1.x output:
- Old `out/<runId>/<slug>/` directories are left untouched but no longer surfaced in the browser. Remove them when you're ready: `rm -rf out/2026*/` (the run-id format).
- Your records start fresh on the new flat layout.
- Manually-edited records: if you've hand-edited a `record.json` between crawls, v2.0 will refuse to overwrite it. Commit your edits inside `out/` (`cd out && git add . && git commit -m "manual edits"`) or pass `--force-overwrite` to discard them.

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
  + extracted audit report text
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
- Audit `reportUrl` PDF/HTML pages discovered by R1 are downloaded and text-extracted before R2; the resulting `audit_reports` evidence helps verify audit dates, scopes, auditors, and report URLs.
- Claude R2 uses the web reconcile prompt and can perform fresh WebFetch/WebSearch. OpenAI-compatible R2 uses an evidence-only prompt. With `external_first`, the external result must pass schema validation, merge-guard checks, and high-risk change checks before it is accepted; otherwise R2 fails closed. With `external_first_with_claude_fallback`, Claude R2 reruns from the original R1 record plus any enriched search evidence when the external result is rejected.
- Search requests are limited and routed through approved fetcher search channels.
- Every accepted change is recorded in `changes.json`.

### Normalize And Validate

Consumer normalizers apply deterministic fixes:

- `rootdata-avatar` — `members[].avatarUrl` is filled after R2. Existing OneKey member-avatar CDN paths are preserved; otherwise RootData project member candidates are matched by exact name first. If the project-scoped candidates miss a verified member, the normalizer searches RootData people directly by `memberName` and requires the result bio to mention the protocol. Paid Unavatar from verified X/LinkedIn links or handle-like pseudonyms is the final fallback. `pbs.twimg.com` temp signed URLs are rejected. The team subtask still emits `null`; `logo-assets` downloads the source image and rewrites the final JSON to the OneKey CDN.
- `logo-assets` — downloads/rehosts logo fields into shared folders under `out/` and rewrites JSON to `https://uni.onekey-asset.com/static/logo/...`:
  - `providerLogoUrl` → `out/protocol-logo/`
  - `members[].avatarUrl` → `out/protocol-member-logo/`
  - `audits.items[].auditorLogoUrl` → `out/audit-logo/`
  Filenames are deterministic: provider logos use `<slug>.<ext>`, member logos use `<slug>-<member-name>.<ext>`, and audit logos use `<auditor>.<ext>`, with names lowercased and punctuation collapsed to `-`. Existing local files are reused, so repeated refreshes do not re-download the same logo. Audit firm logos prefer the current record value, then existing local files and `out/*/record.json` records; if missing, the normalizer performs an exact RootData project search and rehosts the RootData `logo` value. If RootData's exact audit-firm match exposes a GitHub link but no logo, the normalizer can fetch the GitHub organization avatar through paid Unavatar and rehost it.
- `protocol-info-final` — sets `audits.lastScannedAt` to UTC today and removes placeholder `members[].oneLiner` text by setting it to `null`.

The final `record.json` must pass `consumers/protocol-info/schemas/full.json`.

### i18n And Export

If `--i18n` is set, the configured i18n provider translates fields from the manifest. By default this is Claude Haiku; set `I18N_PROVIDER=openai` plus OpenAI-compatible config to use an external gateway instead. You can provide that config with one-shot `--openai-*` flags, exported shell env, `~/.config/protocol-info/.env`, or `<repo>/.env`, in that order. Add `OPENAI_INPUT_COST_PER_1M` and `OPENAI_OUTPUT_COST_PER_1M` or their matching CLI flags when combining OpenAI-compatible i18n with `--max-budget`.

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
  "providerLogoUrl": "https://uni.onekey-asset.com/static/logo/protocol-logo/pendle.png",
  "displayName": "Pendle",
  "type": "fixed_rate",
  "description": "...",
  "tags": ["yield", "fixed-rate"],
  "establishment": 2021,
  "members": [
    {
      "memberName": "Example Member",
      "memberPosition": "Co-Founder",
      "oneLiner": "Previously built DeFi infrastructure.",
      "avatarUrl": "https://uni.onekey-asset.com/static/logo/protocol-member-logo/pendle-example-member.png",
      "memberLink": {
        "xLink": "https://x.com/example",
        "linkedinLink": null
      }
    }
  ],
  "providerWebsite": "https://...",
  "providerXLink": "https://...",
  "providerDiscordLink": null,
  "status": "draft",
  "fundingRounds": [],
  "audits": {
    "items": [
      {
        "auditor": "OpenZeppelin",
        "auditorLogoUrl": "https://uni.onekey-asset.com/static/logo/audit-logo/openzeppelin.png",
        "date": "2024-05",
        "scope": "Core protocol contracts",
        "reportUrl": "https://..."
      }
    ],
    "lastScannedAt": "2026-04-27"
  },
  "sources": ["https://..."]
}
```

Important constraints:

- `type`: `fixed_rate`, `simple_earn`, or `staking`
- `status`: crawler output should be `draft`
- `members`: at least one entry
- `members[].oneLiner`: concrete verified background or `null`; placeholder text such as `Unverified`, `TBD`, `N/A`, or `暂未提供` is normalized back to `null`
- `providerLogoUrl`, `members[].avatarUrl`, and `audits.items[].auditorLogoUrl`: absolute URLs or `null`; when found, the normalizer rewrites them to `https://uni.onekey-asset.com/static/logo/...`. Member avatars use RootData first, then direct RootData person search, then paid Unavatar from verified social links or handle-like pseudonyms. Audit logos prefer current/manual values, then local cache/cross-protocol records, then exact RootData project search, with RootData GitHub links as a paid Unavatar fallback.
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

1. Open `out/index.html` or `out/.runs/<run-id>/summary.tsv`.
2. For each `OK` row, review `out/<slug>/record.json`.
3. In the `Assets` panel, confirm provider, member, and auditor logos exist locally before uploading the logo folders.
4. Check `findings.json` for source coverage.
5. Check `gaps.json` for missing or weak fields.
6. Check `changes.json` when R2 changed R1 output.
7. Import `record.import.json` after review.

Example import:

```bash
curl -X POST "$DASHBOARD/api/earn-protocol-info/import" \
  -H "Content-Type: application/json" \
  -d @out/<slug>/record.import.json
```

Even without i18n, `record.import.json` contains one source-language record with dashboard locale `en`.

## Troubleshooting

### `claude CLI not found`

Install Claude Code and ensure `claude` is on `PATH`, or set `CLAUDE_BIN`:

```bash
CLAUDE_BIN=/path/to/claude ./run.sh --display-name "Pendle"
```

### RootData is disabled

Pass `--rootdata-key sk-...` for a one-shot run, export `ROOTDATA_API_KEY` in your shell, or write it to `~/.config/protocol-info/.env` (preferred) or `<repo>/.env`. The startup banner shows which source was used. Without a key, RootData fetch and search channels are skipped. Paid Unavatar uses `--unavatar-key` or `UNAVATAR_API_KEY` from the same config locations.

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
out/<slug>/_debug/i18n/
```

Successful locale sidecars are still used by post-processing.

### Output path changed

The current layout is protocol-first:

```text
out/<slug>/
out/.runs/<run-id>/summary.tsv
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
