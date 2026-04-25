# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Zero-dep `validate.mjs` JSON Schema validator.
