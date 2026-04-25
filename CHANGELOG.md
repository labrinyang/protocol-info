# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-25

Major migration: monolithic bash crawler → reusable Deep Research framework.
Standalone CLI and Claude Code plugin behavior preserved; outputs (record.json,
record.import.json, record.full.json, meta.json) and CLI flags unchanged.

### Added
- `framework/` — reusable Deep Research engine (manifest-driven, consumer-agnostic):
  - `framework/cli.mjs` (CLI entry, replaces the bash main loop)
  - `framework/orchestrator.mjs` (per-provider sequencer)
  - Per-stage CLI shims under `framework/cli/`: `fetch.mjs`, `r1.mjs`, `r2.mjs`,
    `evidence-diff.mjs`, `normalize.mjs`, `i18n.mjs`, `post.mjs`
  - Reusable utilities: `claude-wrapper.mjs`, `parallel-runner.mjs`,
    `manifest-loader.mjs`, `subtask-runner.mjs`, `merger.mjs`,
    `i18n-stage.mjs`, `normalizer-stage.mjs`, `search-channel.mjs`,
    `evidence-diff.mjs`, `schema-validator.mjs`, `json-extract.mjs`
  - Universal schemas: `findings.schema.json`, `gaps.schema.json`,
    `changes.schema.json`, `consumer-manifest.schema.json`
- `consumers/protocol-info/` — protocol-info as the first framework consumer:
  - `manifest.json` declares fetchers, R1 subtasks, reconcile config, i18n
    catalog, normalizers, post-processing.
  - 4 R1 subtask slice schemas (metadata / team / funding / audits) and
    matching prompt templates.
  - 4 fetchers (rootdata, defillama).
  - β-shape output: each subtask returns `{slice, findings, gaps, handoff_notes}`.
- R1 fan-out: 4 parallel subtasks (metadata / team / funding / audits) merge
  into a single record. Per-subtask Claude session, per-subtask budget caps.
- R2 audit-first reconcile: synthesis-and-deepening pass with audit guard
  (high-confidence R1 fields can't be silently overwritten without provenance);
  optional RootData search-channel for targeted deepening rounds.
- Findings/gaps/changes provenance: every record field can carry a finding
  (source URL + confidence) and a change record (R2 mutations); unresolved
  fields are tracked as gaps with what was tried. Audit trail is auditable
  via `findings.json`, `changes.json`, `gaps.json` next to `record.json`.
- Type inference: `--type` is now optional. The metadata subtask infers it
  from evidence; previous CLI hint was a leakage source that biased output.

### Changed
- Bash `run.sh` is now a 37-line shim: .env autoload + `exec node framework/cli.mjs`.
  All pipeline logic moved to Node. Net: ~600 bash lines deleted.
- `validated_overrides` (RootData providerWebsite / providerXLink) applied
  in JS at the orchestrator (no jq dependency).
- `audits.lastScannedAt` now set by `consumers/protocol-info/normalizers/final.mjs`
  (deterministic post-R2 stage), not a bash one-liner.
- Per-subtask budgets default to $1.50 (was $0.50 — proved too tight on
  PDF-heavy audits subtask).
- i18n stage and dashboard export ported to Node modules; `record.import.json`
  byte-shape preserved (modulo `exportedAt` timestamp).
- Plugin and standalone CLI flag set unchanged: `--display-name`, `--type`,
  `--slug`, `--hints`, `--rootdata-id`, `--batch`, `--model`, `--parallel`,
  `--i18n`, `--i18n-parallel`, `--i18n-model`, `--dry-run`.

### Removed
- Bash functions: `slugify`, `flush_provider`, `run_one`, `i18n_pick_interactive`,
  `i18n_translate_one`, `i18n_dispatch`, `locale_name_for`,
  `dashboard_locale_for`, `export_dashboard_record`. All replaced with Node
  equivalents.
- The legacy `--resume` session approach for R2: structurally incompatible
  with fan-out R1 (each subtask has its own session_id). R2 now starts a
  fresh session per round and receives merged record + full evidence inline.
- The `jq` runtime dependency.

### Architecture notes
- A new consumer can be added by writing a manifest + slice schemas + prompt
  templates + (optionally) fetchers + (optionally) normalizers + post-processing
  modules. The framework provides everything else.
- Zero runtime dependencies: pure ESM `.mjs`, Node stdlib only.

### Known limitations
- Locale catalog has 19 entries; dashboard supports 21. Two locales pending
  authoritative confirmation.
- `--max-turns` / `--max-budget` CLI flags accepted but currently overridden
  by per-subtask manifest values; revisit if a global cap is needed.

## [0.4.0] — 2026-04-25

### Added
- New output `out/<ts>/<slug>/record.import.json` — dashboard-ready
  `{version, exportedAt, data:[...]}` envelope, one entry per locale
  (source `en` plus each translated locale). Replaces the manual
  `jq 'del(...)'` import workflow. Always emitted for OK slugs even
  when `--i18n none`.
- `dashboard_locale_for` helper that maps our underscore-mixed-case
  locale codes (`en_US`, `zh_CN`, `pt_BR`, ...) to dashboard's
  hyphen-lowercase format (`en`, `zh-cn`, `pt-br`, ...). Drops
  redundant region suffixes when there's only one variant per language.

### Changed
- `establishment` schema range loosened from `2008-2100` to `1900-2030`
  to match dashboard's `1900~currentYear+1` constraint.
- Import documentation in README now points at `record.import.json` as
  the canonical dashboard-import artifact (the old `del(.providerWebsite,
  .providerXLink, .providerDiscordLink, .sources)` recipe was based on
  an outdated assumption — dashboard accepts those fields).

### Notes
- Dashboard supports 21 locales; we currently configure 19. Two are
  still missing — locale catalog will be updated when the authoritative
  list is provided.

## [0.3.0] — 2026-04-24

### Added
- Packaged as a public Claude Code plugin with its own `marketplace.json`.
  Install via `/plugin marketplace add labrinyang/protocol-info` then
  `/plugin install protocol-info@labrinyang`.
- New slash command `/protocol-info` — wraps the standalone `run.sh` with
  plugin-path-aware invocation via `${CLAUDE_PLUGIN_ROOT}`.
- New skill `protocol-info-crawler` — auto-dispatches the slash command from
  natural-language requests like "调研 Pendle 的项目概述,翻中日英".
- `run.sh` now also looks at `$HOME/.config/protocol-info/.env` for
  `ROOTDATA_API_KEY`, so plugin users have a writable location that survives
  plugin updates.
- Headless (non-tty) invocation with no `--i18n` flag now prints a single
  stderr line explaining why translation was skipped, instead of silently
  dropping through the interactive picker.
- `LICENSE` (MIT) and this `CHANGELOG.md`.

## [0.2.0] — 2026-04-24

### Added
- Per-provider output directory layout: `out/<ts>/<slug>/{record.json,
  record.full.json, meta.json, _debug/}`. `record.full.json` merges `.i18n`
  when translations ran.
- `meta.json` nested telemetry: `{r1, r2, source_used, rootdata, i18n}`,
  replaces the flat sidecar.
- Haiku i18n stage: per-locale Haiku calls with schema-forced output,
  bounded parallelism (default 8). Translates only `description` +
  `members[].{memberPosition, oneLiner}`; identifiers/URLs/dates/brand/
  person names stay untouched.
- `--i18n`, `--i18n-parallel`, `--i18n-model` CLI flags. 19-locale catalog.
  Interactive picker on tty.
- `schema/i18n.schema.json`, `prompts/i18n.system.md`, `prompts/i18n.user.md.tmpl`.
- `parse.stderr.log` / `schema.stderr.log` are only left on disk when the
  corresponding stage actually failed (clean success = no stray files).
- Stderr summary of i18n failures per slug so partial failures don't hide
  inside `summary.tsv`.

### Changed
- `summary.tsv` gained an `i18n` column (`ok/total` or `-`).
- Round 2 cost / turn extraction hardened against non-numeric envelope
  values.

## [0.1.0] — earlier

- Initial bash pipeline: `run.sh` Round 1 + optional Round 2 via RootData.
- Bounded-concurrency `--parallel` dispatcher.
- Zero-dep schema validator (later moved to framework/schema-validator.mjs in 1.0.0).
