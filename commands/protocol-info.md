---
description: Crawl a DeFi protocol into schema-validated EarnProtocolInfo JSON with optional Haiku i18n (19 locales)
argument-hint: "--display-name <name> --type <simple_earn|fixed_rate|staking> [--slug x] [--hints ...] [--i18n all|zh_CN,ja_JP,...] [--parallel N] [--batch ...]"
allowed-tools: Bash
---

# /protocol-info:protocol-info

Run the protocol-info crawler pipeline with the user's arguments. The pipeline is a bash script (`run.sh`) bundled with this plugin; it does:

1. **Round 1** — Claude searches the web, produces a strict-schema JSON record
2. **RootData API** (if `ROOTDATA_API_KEY` is set) — fetches structured evidence in parallel
3. **Round 2** — resumes the Claude session with API evidence to cross-check
4. **Validate** — runs zero-dep JSON Schema validation
5. **i18n** (optional) — Haiku translates `description` + `members[].{memberPosition, oneLiner}` to selected locales

## How to run

Execute exactly:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/run.sh" $ARGUMENTS
```

Do not re-parse the args or transform them — pass through verbatim. If the user omits required arguments, the script will error clearly; don't pre-validate.

## Runtime output in Claude Code

Claude Code captures Bash stdout/stderr as plain text command output, not rich markdown. The runner therefore prints only low-frequency key lines:

- one line when each provider starts
- output directory
- R0/R1/R2/i18n/post stage start or completion
- one heartbeat per long-running R1/R2/i18n stage, at most once per minute
- final `=== Summary ===` table
- an `Out browser:` path to `out/index.html`

Do not ask the script to stream raw Claude/debug logs. They are written under `out/<slug>/<run-id>/_debug/`. The generated `out/index.html` is a static local page for filtering runs, comparing same-protocol JSON across runs, and copying key artifacts.

## After the run finishes

1. **Read the "=== Summary ===" block** from stdout and relay it verbatim to the user
2. For each row where `status=OK`, point to:
   - `out/<slug>/<run-id>/record.import.json` — dashboard import envelope `{version, exportedAt, data:[...]}`
   - `out/<slug>/<run-id>/record.json` — source-language crawler record for review/schema audit
   - `out/<slug>/<run-id>/record.full.json` — inline-i18n merged version (only if translations ran)
   - `out/index.html` — local browser for filtering runs, comparing same-protocol JSON, and copying paths/JSON
3. If any row shows `CRAWL_FAIL`, `PARSE_FAIL`, or `SCHEMA_FAIL`, call it out explicitly — stderr already dumped the key failure details, no need to re-investigate unless the user asks
4. If `i18n` column shows partial failures (e.g. `3/19`), mention which locales failed (read `out/<slug>/<run-id>/_debug/i18n/failures.log` if needed)

## Do not

- Don't modify any output files — the user reviews and imports manually
- Don't re-run automatically on failure — surface the error, let the user decide
- Don't try to interpret `meta.json` / audit files unless the user asks
- Don't offer to commit the output directory — `out/` is gitignored

## Examples the user may invoke

```
/protocol-info:protocol-info --display-name "Pendle" --type fixed_rate
/protocol-info:protocol-info --display-name "Pendle" --type fixed_rate --i18n all
/protocol-info:protocol-info --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" --type fixed_rate \
  --batch --display-name "Morpho" --type simple_earn
/protocol-info:protocol-info --dry-run --display-name "Pendle" --type fixed_rate
```

## Environment

`ROOTDATA_API_KEY` (optional) enables Round 2 reconciliation. Lookup order:
1. `$ROOTDATA_API_KEY` in the shell Claude Code inherits
2. `$HOME/.config/protocol-info/.env` (recommended for plugin users — writable, persists across plugin updates)
3. `.env` next to `run.sh` (standalone CLI only — when installed as a plugin this is the read-only plugin cache)

To enable Round 2 via plugin, run this once:
```bash
mkdir -p ~/.config/protocol-info
echo "ROOTDATA_API_KEY=sk-..." > ~/.config/protocol-info/.env
chmod 600 ~/.config/protocol-info/.env
```

Pipeline needs `claude` and `node` on PATH. The user has Claude Code installed, so `claude` is usually available.
