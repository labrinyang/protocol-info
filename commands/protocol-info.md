---
description: Crawl or edit DeFi protocol-info records with schema validation, i18n, and local git history
argument-hint: "--display-name <name> [...] | get/set/analyze/i18n/refresh/history/diff/restore <slug> [...]"
allowed-tools: Bash
---

# /protocol-info:protocol-info

Run the protocol-info crawler pipeline with the user's arguments. The pipeline is a bash script (`run.sh`) bundled with this plugin; it does:

1. **R0 fetchers** — RootData/DeFiLlama evidence when keys are available
2. **R1 synthesis** — Claude produces schema-slice records for metadata/team/funding/audits
3. **R2 reconcile** — Claude cross-checks R1 against structured evidence
4. **Normalize** — deterministic post-R2 fixes, including RootData member avatars, RootData-backed audit logos, rehosted provider/member/audit logos, and `oneLiner` placeholder cleanup
5. **Validate** — zero-dep JSON Schema validation
6. **i18n** (optional) — Claude Haiku by default, or `I18N_PROVIDER=openai` for OpenAI-compatible API translation
7. **Post/export + history** — writes dashboard import artifacts and scoped local git commits; review uses the live out browser

The same runner also supports workflow subcommands on an existing
`out/<slug>/`: `get`, `set`, `analyze`, `i18n`, `refresh`, `history`, `diff`,
and `restore`. Pass those through verbatim too.

## How to run

Execute exactly:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/run.sh" $ARGUMENTS
```

Do not re-parse the args or transform them — pass through verbatim. If the user omits required arguments, the script will error clearly; don't pre-validate.

Do not pass a protocol type argument. `record.type` is inferred from evidence by
the metadata subtask, not supplied as a CLI input.

By default, the runner writes to `out/` under the current working directory
where this slash command is invoked, not under the plugin cache. This keeps
protocol history stable across plugin updates.

## Runtime output in Claude Code

The notes below describe full crawl output. Workflow subcommands are shorter:
read-only commands print their direct result, and write commands validate,
normalize deterministic fields, invalidate stale i18n, post-process, commit
inside `out/`; the live out browser reads the updated JSON directly.

Claude Code captures Bash stdout/stderr as plain text command output, not rich markdown. The runner therefore prints only low-frequency key lines:

- one line when each provider starts
- output directory
- R0/R1/R2/i18n/post stage start or completion
- one heartbeat per long-running R1/R2/i18n stage, at most once per minute
- final `=== Summary ===` table
- an `Out browser:` command for starting the live browser

Do not ask the script to stream raw Claude/debug logs. They are written under `out/<slug>/_debug/`. The live out browser reviews protocol artifacts, filters recent runs, shows git history and latest diffs, and copies key artifacts. It reads the current `out/` tree directly, so `out/<slug>/record.json` changes appear without regenerating HTML.
R1 also writes live subtask telemetry to `out/<slug>/_debug/r1/r1-status.json`
with queued/running/ok/failed state, pid, elapsed time, timeout, and error kind.
Claude invocations have a default wall-clock watchdog (`CLAUDE_TIMEOUT_MS`,
30 minutes; `R1_CLAUDE_TIMEOUT_MS` overrides R1), so a stalled subtask fails as
`error_kind=timeout` and the R1 partial path can continue.

## After the run finishes

Keep the reply tight. The reviewer's main tool is the live out browser — surface the printed command first. Per-record JSON paths are inside the browser already, so do not enumerate them in the reply.

Required reply shape for full crawl runs (in this order, nothing else unless something failed):

1. **One-line outcome.** Pull the OK / FAIL / PARTIAL counts from the `=== Summary ===` block. Example: `Done — 2 OK, 0 fail. i18n: zh_CN, ja_JP, en_US.` Skip the i18n clause when `--i18n none` or unset.
2. **Out browser command.** Take the `Out browser:` command printed at the end of stdout and surface it as the primary call to action. Format:

   > **Open the run browser**: run `<printed Out browser command>`, then open the printed local URL.

   Use the command verbatim from stdout; it includes the resolved `--out` path.
3. **Failures only when present.** If any row shows `CRAWL_FAIL`, `PARSE_FAIL`, or `SCHEMA_FAIL`, list those slugs after the link with the failure stage from the summary — stderr already dumped the details, do not re-investigate unless the user asks. If `i18n` is partial (`3/19`), name the locales that failed (read `out/<slug>/_debug/i18n/failures.log` only if the user asks).

For workflow subcommands, summarize the command result directly. For
`analyze` without `--apply`, surface the printed proposal. For write
subcommands, say whether it completed and mention that the canonical record was
updated in `out/<slug>/`.

Do **not**:
- Print the full `=== Summary ===` table — the HTML browser shows the same data with filtering.
- List `record.import.json` / `record.json` / `record.full.json` paths per slug — they're one click away inside the browser.
- Add a "next steps" / "review and import" paragraph — the Cmd-click hint above is the next step.

## Do not

- Don't modify any output files — the user reviews and imports manually
- Don't re-run automatically on failure — surface the error, let the user decide
- Don't try to interpret `meta.json` / audit files unless the user asks
- Don't offer to commit the output directory to the project repo — `out/` is ignored by the outer repo and maintains its own local git history

## Examples the user may invoke

```
/protocol-info:protocol-info --display-name "Pendle"
/protocol-info:protocol-info --display-name "Pendle" --i18n all
/protocol-info:protocol-info --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" \
  --batch --display-name "Morpho"
/protocol-info:protocol-info --dry-run --display-name "Pendle"
/protocol-info:protocol-info get pendle description
/protocol-info:protocol-info analyze pendle fundingRounds --query "verify latest funding rounds"
/protocol-info:protocol-info analyze pendle fundingRounds --query "verify latest funding rounds" --apply
```

## Environment

`ROOTDATA_API_KEY` (optional) enables Round 2 reconciliation. Lookup order (highest priority first):
1. `--rootdata-key <key>` flag passed to the slash command (one-shot; never written to disk)
2. `$ROOTDATA_API_KEY` in the shell Claude Code inherits
3. `$HOME/.config/protocol-info/.env` (recommended for plugin users — writable, persists across plugin updates)
4. `.env` next to `run.sh` (standalone CLI only — when installed as a plugin this is the read-only plugin cache)

The runner's startup banner reports which source supplied the key.

To enable Round 2 via plugin without writing a file:
```
/protocol-info:protocol-info --rootdata-key sk-a,sk-b --display-name "Pendle"
```

Or persist the key once:
```bash
mkdir -p ~/.config/protocol-info
echo "ROOTDATA_API_KEY=sk-..." > ~/.config/protocol-info/.env
chmod 600 ~/.config/protocol-info/.env
```

For concurrent batches, `ROOTDATA_API_KEYS=sk-a,sk-b,sk-c` or numbered
`ROOTDATA_API_KEY_1` / `ROOTDATA_API_KEY_2` entries are supported. RootData
requests start from a random key and fall back across the pool on rate-limit or
API failure.

`UNAVATAR_API_KEY` is optional but recommended for stable paid avatar/logo
rehosting. It follows the same lookup order as RootData, or can be passed once
with `--unavatar-key <key>`. Member avatars use RootData first, then direct
RootData person search, then verified social links through Unavatar as a final
fallback; audit logos may use RootData GitHub links as a Unavatar fallback when
no RootData logo is available.

Pipeline needs `claude` and `node` on PATH. The user has Claude Code installed, so `claude` is usually available.

External LLM provider knobs:

- `I18N_PROVIDER=openai` routes i18n to an OpenAI-compatible Chat Completions API.
- `R2_LLM_PROVIDER=openai` routes R2 synthesis to that API.
- `ANALYZE_LLM_PROVIDER=openai` routes workflow `analyze` to that API.
- `AUDIT_REPORTS_LLM_PROVIDER=openai` asks the external LLM to structurally read fetched audit report text before R2.
- `REFRESH_<SUBTASK>_LLM_PROVIDER=openai`, for example `REFRESH_AUDITS_LLM_PROVIDER=openai`, routes one refresh subtask.
- `R2_ROUTING=external_first` or `--r2-routing external_first` tries OpenAI-compatible evidence-only R2 and fails closed when the deterministic gate rejects it.
- `R2_ROUTING=external_first_with_claude_fallback` or `--r2-routing external_first_with_claude_fallback` tries OpenAI-compatible evidence-only R2 first and falls back to Claude web R2 when the deterministic gate rejects it.

OpenAI-compatible config follows the same lookup order as RootData:
1. One-shot flags: `--openai-api-key`, `--openai-base-url`, `--openai-model`, `--openai-input-cost-per-1m`, `--openai-output-cost-per-1m`
2. Shell env: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, pricing vars
3. `$HOME/.config/protocol-info/.env`
4. `.env` next to `run.sh`

Example:
```
/protocol-info:protocol-info --openai-api-key sk-... --openai-base-url https://llm.example.com/v1 --openai-model gpt-5.5 --i18n all --display-name "Pendle"
```

All OpenAI-compatible routes read `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`. Configure `OPENAI_INPUT_COST_PER_1M` and `OPENAI_OUTPUT_COST_PER_1M`, or pass the matching one-shot pricing flags, to make those calls produce numeric `cost_usd` and participate in `--max-budget`; without pricing they report `cost_usd: null`. Stage policy allows external LLM by default for i18n, R2, analyze, audit-report reading, and refresh audits, but blocks R1 and other refresh subtasks unless the manifest explicitly opts them in. Direct OpenAI-compatible R2 and external audit refresh use evidence-only prompts; Claude R2 and Claude refresh keep the web-research prompts. The startup banner reports key/base/model/pricing sources without printing the API key.
