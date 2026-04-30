# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.0] — 2026-04-30

### Changed
- Default output root now resolves to the caller's current working directory
  (`<cwd>/out`) instead of the plugin/repository directory. Plugin updates no
  longer move where generated records, local history, and `out/index.html`
  appear.
- Full crawl CLI no longer accepts `--type`; `record.type` is inferred by the
  metadata subtask from evidence instead of being supplied as a user input.
- Audit-firm logos are now resolved deterministically from local/cross-protocol
  cache first, then exact RootData project search, before being rehosted under
  `out/audit-logo/`.
- Member avatars now use RootData project candidates first, then direct
  RootData person search by `memberName` when project-scoped candidates miss a
  verified member, then paid Unavatar sources derived from verified X/LinkedIn
  links or handle-like pseudonyms. Downloaded images still land in
  `out/protocol-member-logo/`, so final JSON points at the OneKey static logo
  CDN, not RootData or unavatar.io.
- Audit-firm logo resolution now preserves current/manual values before cache
  and RootData, and can use a RootData exact match's GitHub link as a paid
  Unavatar fallback when RootData has no logo field.
- `--unavatar-key` / `UNAVATAR_API_KEY` configure paid Unavatar requests with
  the same one-shot/env/`~/.config/protocol-info/.env` pattern as RootData.
- Placeholder `members[].oneLiner` strings such as `Unverified`, `TBD`, `N/A`,
  or `暂未提供` are normalized back to `null` so missing member background
  remains visible for later completion.
- Normalizers now remove stale incoming gaps for fields they resolve to a
  concrete value, so `gaps.json` reflects the current backlog instead of old
  missing-field notes.

## [2.2.0] — 2026-04-29

### Added
- `providerLogoUrl` on protocol records, populated deterministically from
  RootData project logo evidence when available.
- `logo-assets` normalizer: downloads provider, team member, and audit-firm
  logos into `out/protocol-logo/`, `out/protocol-member-logo/`, and
  `out/audit-logo/`, then rewrites JSON fields to
  `https://uni.onekey-asset.com/static/logo/...` paths.
- `audit-reports` evidence stage: after R1 discovers audit `reportUrl`
  values, the runner downloads PDF/HTML reports, extracts the first pages or
  report text, and feeds `audit_reports` evidence into R2 and `refresh audits`
  so audit dates/scopes are not based only on Claude's web reading.
- OpenAI-compatible structured LLM routing for low/no-web stages. `i18n` can
  use `I18N_PROVIDER=openai`; R2, analyze, and refresh subtasks can opt in
  with stage-specific `*_LLM_PROVIDER=openai` environment variables. Gateway
  costs are recorded as unknown until pricing env vars are configured, and
  stage policy blocks web-required stages from accidentally using an
  evidence-only external provider.

### Changed
- Write workflows now run consumer normalizers before validation/post-processing
  so `set`, `analyze --apply`, `refresh`, and `restore` keep rehosted logo
  fields consistent with full crawls.
- Audit logo handling reuses matching auditor logos already present in existing
  `out/*/record.json` records before fetching a new image.
- External audit refresh now uses an evidence-only audits prompt, and R2 routing
  modes are normalized so `external_first` fails closed while
  `external_first_with_claude_fallback` is the only automatic Claude fallback.

## [2.1.0] — 2026-04-27

### Added
- Workflow subcommands on existing canonical records:
  `get`, `set`, `analyze`, `i18n`, `refresh`, `history`, `diff`, and
  `restore`.
- Importable `schema-validator.mjs` helpers (`validate`, `validateFile`,
  `validateRecord`) so write commands can validate in-process without
  spawning the CLI.
- Transaction helpers for write commands: dirty-slug preflight, rollback to
  `HEAD`, post-processing, one logical commit, and browser rebuild.
- Field-level `analyze`: proposal-only by default; `--apply` writes only the
  requested JSONPath after full-record validation.

### Changed
- `i18n <slug>` now operates on the current `out/<slug>/record.json`, writes
  locale sidecars through the existing i18n stage, then runs post-processing
  before committing `record.full.json`, `record.import.json`, and `meta.json`.
- `refresh <slug> <subtask>` uses the existing R1 subtask prompt path and
  merges refreshed slices through the same audit-first `mergeR2` envelope
  contract used by crawl reconciliation.

## [2.0.0] — 2026-04-27

**Breaking change.** Output layout flipped from `out/<runId>/<slug>/` to
`out/<slug>/`. `out/` is now a local git repo (`out/.git/`) with one
commit per successful crawl.

### Added
- `framework/version-store.mjs`: real-git wrapper providing `ensureRepo`,
  `commit`, `log`, `diff`, `restore`, `isClean`. `out/` becomes a local
  git repo on first crawl. Pure shell-out via `child_process.spawn`, no
  new dependencies.
- Per-slug auto-commit on successful crawl. Each crawl produces one
  commit, e.g. `crawl(pendle): R1+R2 ok`, with a `Run-Id:` git trailer
  carrying the batch identifier.
- Failed crawls roll the protocol directory back to HEAD, keeping only
  ignored `_debug/` debris for triage. A failed first crawl leaves no
  canonical `record.json`.
- `out/.runs.log`: append-only TSV of (timestamp, runId, slugs, outcome).
  Powers the runs filter in the browser without putting run-id back in
  any data path.
- `--force-overwrite` flag: opt-in escape hatch to overwrite a slug
  with uncommitted edits. Without it, a fresh crawl refuses to clobber
  a manually-edited record (the no-overwrite-on-fail safety guarantee).

### Changed
- Path layout: `out/<slug>/record.json` is the canonical record (no
  run-id segment in the data path).
- Per-batch scratch (`.summary-rows/`, `.worker-logs/`, `summary.tsv`)
  moved to `out/.runs/<runId>/` (gitignored).
- Browser: protocols-first nav with per-protocol git history pane;
  runs become a secondary `<details>` filter sourced from `.runs.log`.
  Diff view compares git commits (HEAD vs HEAD~1 by default), not run
  directories. ~260 lines of across-runs comparison code dropped.
- `framework/cli.mjs`: argv parsing extracted to a pure exported
  `parseArgv(argv)` function so the `--force-overwrite` plumb path is
  unit-testable end-to-end.

### Removed
- `protocolRunDir(out, slug, runId)` export — replaced by
  `protocolDir(out, slug)`.
- Across-runs JS comparison helpers in `out-browser.mjs`
  (`buildComparePanel`, `bindComparePanel`, `diffArtifacts`, `walkDiff`,
  `arrayIdentity`, `isVolatilePath`, `formatDiffSummary`,
  `renderDiffItem`).
- Per-slug `summary.tsv` from version history. It may still be generated
  for the local browser, but it is gitignored and not part of canonical
  protocol history.

### Migration
Old `out/<runId>/<slug>/` directories are left untouched but invisible
to the new browser. Clear them with `rm -rf out/2026*/` when convenient.
New records land at `out/<slug>/` automatically. See README's
"Upgrading from 1.x" subsection for details.

### Deferred to v2.1.0
The user-facing workflow CLIs. v2.0 ships the foundation; v2.1 adds the
decoupled commands that run on top of an existing `out/<slug>/`.

## [1.2.1] — 2026-04-27

### Changed
- `commands/protocol-info.md` post-run reply rewritten. The reply now
  leads with the absolute `out/index.html` path plus a Cmd-click hint
  ("Cmd-click to open in your browser"), instead of dumping the full
  summary table and per-record JSON paths. Failures are still surfaced,
  but the HTML browser is the primary review surface — per-record
  paths are one click away inside it.

## [1.2.0] — 2026-04-27

### Changed
- `members[].avatarUrl` is now sourced exclusively from RootData
  (`member_candidates[].avatar_url`) by name match. The team R1 subtask
  emits `null`; a new `rootdata-avatar` normalizer runs after R2 and
  writes the URL deterministically. Members RootData doesn't index keep
  `avatarUrl: null` plus a `gaps.json` entry — they are no longer given
  unavatar.io URLs.
  - **Why**: unavatar.io enforces a 25 req/day-per-IP anonymous rate
    limit (50/day with a free key), confirmed against unavatar's own
    docs. A public dashboard rendering `<img src="https://unavatar.io/...">`
    would systematically 429 behind any shared NAT (corporate, mobile,
    edu) and on cold cache. Embedding unavatar URLs in the database was
    not production-viable.
  - **Phase A note**: the URL stored in `record.json` is still RootData's
    CDN URL. Backend ops download and rehost these images on owned
    storage at the database layer, so the dashboard ultimately serves a
    stable in-house URL. Phase B (in-pipeline rehost) is intentionally
    out of scope here.
  - URL quality filter rejects `pbs.twimg.com` (X temp signed links),
    non-https, and malformed URLs.

### Removed
- All `unavatar.io/x/<handle>` and `unavatar.io/github/<handle>`
  guidance from `prompts/system.md` and `prompts/team.user.md.tmpl`.
  The team subtask is now told to always emit `"avatarUrl": null`.

## [1.1.0] — 2026-04-27

### Added
- `out/index.html` — self-contained local browser for the output tree.
  Filter runs by status / locale / consumer, inspect key artifacts, copy
  absolute file paths, copy a single `record.import.json`, or copy a merged
  import JSON for the visible records. Refreshed automatically on every run;
  embeds review artifacts only (raw Claude/debug logs stay under `_debug/`).
- Cross-run path-level JSON compare in `out/index.html`: pick the same
  protocol from two runs and see a path-level diff (added / removed /
  changed) over `record.json`.
- `--rootdata-key <key>` CLI flag — pass a RootData API key for a single
  run without writing a `.env` file. Overrides shell env and `.env` files.
  Never persisted.
- Startup banner now reports the resolved key origin
  (`shell-env`, `--rootdata-key`, or the `.env` path that supplied it),
  so misconfigured installs are obvious at a glance.
- Quiet progress mode for the orchestrator (less noisy stderr during
  multi-slug batch runs).

### Changed
- Default R1/R2 model is now Sonnet (`claude-sonnet-4-6`), declared via a new
  top-level `model_default` field in `consumers/protocol-info/manifest.json`.
  Override per-run with `--model <name>`. i18n is unchanged: still Haiku
  (`claude-haiku-4-5-20251001`) via `manifest.i18n.model_default`.
- `ROOTDATA_API_KEY` lookup now prefers `~/.config/protocol-info/.env`
  over `<repo>/.env`, matching the documented order. Plugin users with a
  stale repo `.env` in the read-only plugin cache no longer shadow their
  user-writable config. Standalone-repo users with only one `.env` are
  unaffected.
- `.env` parser now skips comment lines and treats blank values as missing,
  so an empty `ROOTDATA_API_KEY=` line no longer disables the fetcher
  silently.
- README rewritten in English; `README.zh-CN.md` kept in sync.
- Dashboard export (`record.import.json`) clarified as the canonical
  import envelope; `record.json` documented as the review/audit artifact.

### Fixed
- Schema: tightened audit report date validation.
- Workflow output alignment for the protocol-info consumer.
- Closed 11 gaps surfaced by the chain-trace audit of the framework.

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
