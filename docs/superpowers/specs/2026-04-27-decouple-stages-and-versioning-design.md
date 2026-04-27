# Decouple Stages + Git-Style Versioning Design

Date: 2026-04-27
Target release: 2.0.0 (foundation) + 2.1.0 (stage CLIs)
Status: design approved, awaiting implementation plan

## Goal

Two user-facing capabilities, one architectural foundation:

1. **Decouple stages.** Run `i18n`, edit a key, refresh one subtask, or query a value on top of an existing `out/<slug>/record.json` — without re-crawling.
2. **Single canonical version per protocol** with git-style history. One `out/<slug>/` directory per protocol, with `git log` / `git diff` / `git checkout` as the time-travel surface.

The current design writes every crawl to a new `out/<runId>/<slug>/` tree. After ~30 runs you have 30 copies of every protocol on disk, and the only way to "fix one field" is to manually edit a JSON file in a specific run-id directory and remember which one is canonical. This spec replaces that with one canonical record per protocol, plus a real git history.

## Non-goals (explicit YAGNI cuts)

- No interactive REPL or TUI.
- No re-running individual fetchers in isolation (`re-fetch rootdata`). Use `crawl` if you need the full evidence packet refreshed.
- No generic "research this JSONPath" key-level refresh. Subtask-level refresh only.
- No automatic migration of old `out/<runId>/<slug>/` directories. Cold cut.
- No rollback of partial pipeline state inside a single crawl. Failed crawls leave the previous canonical record intact (per the no-overwrite-on-fail invariant), but you can't restore to "after R1, before R2".

## Decisions (locked during brainstorming)

| Topic | Decision | Reasoning |
|---|---|---|
| Storage layer | Real git inside `out/` (`git init` lazy on first crawl) | Battle-tested diff/log/checkout primitives; no custom snapshot store to maintain. ~80 lines of wrapper code vs ~150+ for a custom store. |
| Stage CLIs | `i18n`, `get`, `set`, `history`, `diff`, `restore`, `refresh` | Covers the explicit "查询分析修改某个 key" loop. `refresh` added during brainstorming as a natural fit for existing subtask infrastructure. |
| Commit granularity | One commit per pipeline run; one per edit/i18n/restore/refresh | Per-stage commits clutter without value (you almost never want to roll back to "after R1 but before R2"). Each entry in `git log` is a recognizable user action. |
| Run-id | Dropped from path; preserved in commit metadata + `out/.runs.log` | Run-id was the source of duplicate-record clutter. `git log` answers "which crawl produced this record"; `.runs.log` answers "which slugs were in batch X" for triage. |
| Migration | Cold cut. Old `out/<runId>/<slug>/` directories ignored by new browser; user clears manually with `rm -rf out/2026*`. | The existing run-ids are dev/test data. One-shot migration code is dead weight after the migration window closes. |

## Architecture

### On-disk layout

```
out/                              ← becomes a git repo (init lazy, on first crawl)
├── .git/                         ← real git, hidden
├── .gitignore                    ← ignores: _debug/, .runs/, .runs.log, index.html
├── .runs/                        ← per-batch scratch (.summary-rows/, .worker-logs/, summary.tsv); gitignored
│   └── 20260427T103211Z/
├── .runs.log                     ← append-only TSV (gitignored): ts \t runId \t slugs \t outcome
├── pendle/                       ← one directory per slug, canonical (TRACKED in git)
│   ├── record.json
│   ├── record.import.json
│   ├── record.full.json          ← only when i18n produced translations
│   ├── findings.json
│   ├── changes.json
│   ├── gaps.json
│   ├── meta.json
│   └── _debug/                   ← gitignored, freely overwritten
├── morpho/
│   └── ...
└── index.html                    ← browser, generated post-stage; gitignored
```

**Tracked vs. ignored:** Only the per-slug record artifacts (`record.json`, `record.import.json`, `record.full.json`, `findings.json`, `changes.json`, `gaps.json`, `meta.json`) are tracked in git history. Generated/transient files (`index.html`, `.runs/`, `.runs.log`, every `_debug/`) are ignored — they have no business in a diff and they'd churn every run.

**Invariants:**

- `out/<slug>/` is *the* state. No run-id in the path. Each crawl overwrites in place; the previous version is reachable via `git log`.
- `_debug/` is gitignored so debug logs don't pollute history or diffs.
- The repo's parent project (`protocol-info` itself) keeps `/out/` in its top-level `.gitignore`. The nested `.git/` doesn't change that — git's outer working tree still treats the entire `out/` as ignored content.
- A failed crawl does NOT overwrite the canonical record. The record stays at the last successful commit; the failed run leaves debris in `_debug/` for triage. The next `crawl` refuses to clobber a dirty working tree without `--force-overwrite`.

### Components

#### `framework/version-store.mjs` (new)

Thin wrapper over `git` shelled out via `child_process.spawn`. No libgit2, no isomorphic-git — `git` on PATH is already required for the plugin (it's installed via Claude Code's marketplace).

Public API (~6 functions, ~80 lines):

```js
ensureRepo(outDir)
  // If out/.git missing: `git init`, write .gitignore, configure local-only
  // user.email and user.name (does not touch user's global git config).
  // Idempotent.

commit(outDir, { paths, message, runId })
  // git add <paths>; git commit -m "<message>" --trailer "Run-Id: <runId>"
  // Returns short sha. No-op if nothing is staged so re-running stages
  // doesn't produce empty commits.

log(outDir, { slug, limit })
  // git log --format=... -- out/<slug>/  →  [{sha, ts, message, runId}]

diff(outDir, { slug, fromSha, toSha })
  // git diff <from> <to> -- out/<slug>/record.json  →  unified diff string

restore(outDir, { slug, sha })
  // git checkout <sha> -- out/<slug>/

isClean(outDir, { slug })
  // git status --porcelain -- out/<slug>/  →  bool
  // Used by `crawl` to detect uncommitted edits before clobbering.
```

Failure handling: if `git` itself fails (PATH missing, repo corrupt) we surface stderr verbatim and exit non-zero. No fallback to non-versioned mode — the design assumes git works.

#### `framework/orchestrator.mjs` (modified)

- `protocolRunDir(out, slug, runId)` deleted. Replace with `protocolDir(out, slug) = join(out, slug)`.
- `runIndexDir` deleted. Per-run summary scratch (`.summary-rows/`, `.worker-logs/`) moves to `out/.runs/<runId>/` (still gitignored), kept for batch crash triage but not exposed in the browser.
- `run()` calls `ensureRepo(outputRoot)` once at top, then runs all providers as today, then for each successful provider calls `commit(outputRoot, { paths: ['<slug>/'], message: 'crawl(<slug>): R1+R2 ok', runId })`.
- `summary.tsv` per batch lands in `out/.runs/<runId>/summary.tsv` and one TSV row per batch is appended to `out/.runs.log`.

#### `framework/cli.mjs` (modified — gains subcommand dispatcher)

Today it parses argv and calls `run()`. New shape:

```
node framework/cli.mjs [subcommand] [args...]

Subcommands:
  crawl        full pipeline (current behavior; default if no subcommand)
  i18n         re-translate existing record
  get          read a JSON path
  set          edit a JSON path with schema validation
  history      git log for one slug
  diff         git diff between two commits
  restore      git checkout to a previous commit
  refresh      re-run one subtask (metadata|team|funding|audits)
```

The dispatcher is a switch on `argv[2]`. Each subcommand lives in its own module under `framework/cli/<name>.mjs` so they can be tested in isolation. The implicit-crawl alias (no subcommand) routes argv to `crawl.mjs` for back-compat with `run.sh`.

#### `framework/cli/i18n.mjs` (new)

`protocol-info i18n <slug> [--locales zh_CN,ja_JP|all]`. Loads `out/<slug>/record.json`, runs the existing `i18n-stage.mjs` against it, writes `record.full.json`, commits as `i18n(<slug>): <locales>`. Errors if `record.json` missing.

#### `framework/cli/get.mjs` (new)

`protocol-info get <slug> <jsonpath>`. Loads `record.json`, walks the path with the small JSONPath dialect (see "JSONPath dialect" below), prints the value as JSON to stdout. No commit. Exit code 1 if the path doesn't resolve.

#### `framework/cli/set.mjs` (new)

`protocol-info set <slug> <jsonpath> <value>`. Loads `record.json`, sets the path to the parsed value, runs the existing slice-schema validator over the result, writes the file iff validation passes, commits as `set(<slug>) <jsonpath>`. Non-zero exit if validation fails; original file is not touched.

`<value>` is JSON-parsed: `set pendle name '"Pendle"'` for strings, `set pendle members[0].active true` for booleans. (Shell quoting hassle is the cost of avoiding a string-vs-JSON guessing game.)

#### `framework/cli/history.mjs` (new)

`protocol-info history <slug> [--limit N]`. Wraps `version-store.log()`, pretty-prints sha / ts / message / runId. Default limit 20.

#### `framework/cli/diff.mjs` (new)

`protocol-info diff <slug> [<sha1>] [<sha2>]`. Wraps `version-store.diff()`. Defaults: `HEAD~1` vs `HEAD`. Outputs unified diff to stdout.

#### `framework/cli/restore.mjs` (new)

`protocol-info restore <slug> <sha>`. Wraps `version-store.restore()`, then re-validates the restored record (defensive — old commits should already be valid, but if a schema tightened since then we want to surface that). Commits as `restore(<slug>) <sha>`.

#### `framework/cli/refresh.mjs` (new)

`protocol-info refresh <slug> <subtask>` where `subtask ∈ {metadata, team, funding, audits}`. Re-runs one subtask via the existing `framework/subtask-runner.mjs`, using the existing `record.json` as evidence (so the model has full context, not a blank slate). The result is merged into the existing record using the same audit-first `mergeR2` guard from `framework/merger.mjs` — high-confidence existing fields aren't silently overwritten. Commits as `refresh(<slug>): <subtask>`.

#### `framework/out-browser.mjs` (modified)

Today it walks `out/` and groups slugs under run-id directories. New version:

- Lists protocols by reading `out/` for directories containing `record.json` (run-id directories ignored).
- Per-protocol history pane sourced from `version-store.log()`, serialized into the page at generate-time.
- Diff view pivots from "compare same path across runs" to "compare current vs commit `<sha>`" — same UI, same path-level coloring, same user-facing question.
- Runs filter (secondary, not primary axis): reads `.runs.log` and lets the user narrow the protocol list to slugs touched by run X.
- Removed: per-run summary tables, same-protocol-across-runs comparison panel, the runs-list left pane.
- Generation trigger unchanged: `crawl` regenerates `index.html` at the end. New stage CLIs (`i18n`, `set`, `restore`, `refresh`) also regenerate it so the page stays fresh.

### Data flow

#### Crawl (full pipeline, today's behavior + auto-commit)

```
ensureRepo(out)
  ↓
parallel for each provider:
  R0 fetch → R1 → R2 → normalize → validate → i18n
  ↓
  if all stages OK:
    commit(out, { paths: [slug + '/'], message: 'crawl(<slug>): R1+R2 ok', runId })
  if any stage failed:
    leave debris in _debug/, no commit, canonical record unchanged
  ↓
append summary row to .runs.log
regenerate index.html
```

#### Stage CLI (i18n on existing record)

```
load out/<slug>/record.json
  ↓
run i18n-stage.mjs
  ↓
write out/<slug>/record.full.json
  ↓
commit(out, { paths: ['<slug>/record.full.json'], message: 'i18n(<slug>): <locales>' })
regenerate index.html
```

#### Stage CLI (set one key)

```
load out/<slug>/record.json
  ↓
parse JSONPath, apply value
  ↓
validate against slice schema
  ↓ (pass)
write out/<slug>/record.json
  ↓
commit(out, { paths: ['<slug>/record.json'], message: 'set(<slug>) <jsonpath>' })
regenerate index.html
```

#### Stage CLI (refresh one subtask)

```
load out/<slug>/record.json + existing evidence
  ↓
subtask-runner.run(subtask, { record_as_evidence: true })
  ↓
mergeR2(existing_record, subtask_result)  ← audit-first guard
  ↓
write out/<slug>/record.json (and record.import.json)
  ↓
commit(out, { paths: ['<slug>/'], message: 'refresh(<slug>): <subtask>' })
regenerate index.html
```

### Error handling

- **Git not on PATH:** surface stderr verbatim, exit non-zero. No fallback.
- **`out/` exists but is not a git repo:** `ensureRepo` runs `git init` in place. Pre-existing files (old `<runId>/` directories) become untracked; they're never staged because `commit()` is called with explicit `paths`.
- **Crawl fails mid-pipeline:** no commit. `_debug/` keeps the failure artifacts. The canonical `record.json` from the previous crawl stays put. Next crawl sees a clean working tree (the failed run never staged anything) and proceeds normally.
- **`set` fails validation:** `record.json` is not written, no commit. Exit non-zero with the validation error. The user fixes their input and retries.
- **Empty stage commit (nothing changed):** `commit()` no-ops if nothing is staged. Re-running `i18n` with the same locales twice produces one commit, not two.
- **`restore` to a sha that doesn't exist:** git's own error is surfaced.

### JSONPath dialect

`get` and `set` accept a tiny dialect — only what's needed. No filters, no recursive descent, no array slicing.

Grammar:

```
path     := segment ( "." segment | "[" index "]" )*
segment  := identifier
identifier := [a-zA-Z_][a-zA-Z0-9_]*
index    := [0-9]+
```

Examples:

- `name` → `record.name`
- `members[0].oneLiner` → `record.members[0].oneLiner`
- `funding.rounds[2].amount_usd` → `record.funding.rounds[2].amount_usd`

`set` only accepts paths that already resolve to a value or a non-existent leaf. Setting `members[10].oneLiner` when the array has length 3 errors out — no implicit array growth.

## Testing

New test files:

- `tests/framework/version-store.test.mjs` — uses a temp dir + real git (already on CI). Exercises every public function plus the no-op-on-empty-staging case plus error paths.
- `tests/framework/cli/i18n.test.mjs` — fixture record, calls i18n CLI, asserts `record.full.json` written + commit landed.
- `tests/framework/cli/get.test.mjs` — table of `(record, path, expected)` triples.
- `tests/framework/cli/set.test.mjs` — happy path, validation-fails-rolls-back, JSONPath that doesn't exist, value parsing edge cases.
- `tests/framework/cli/history.test.mjs` — seed git history, assert pretty-print shape.
- `tests/framework/cli/diff.test.mjs` — seed two commits, assert diff output.
- `tests/framework/cli/restore.test.mjs` — restore + re-validation pass; restore to a sha whose record fails current schema (shouldn't happen but exercise the path).
- `tests/framework/cli/refresh.test.mjs` — mock subtask-runner, assert mergeR2 audit guard kicks in.

Modified test files:

- `tests/framework/orchestrator.test.mjs` — expect flat layout + commit-on-success + no-commit-on-failure.
- `tests/framework/out-browser.test.mjs` — feed git-log fixtures, assert history pane renders.

Existing crawl integration tests need their fixture trees updated: `out/<runId>/<slug>/` → `out/<slug>/`.

## Migration & breaking changes

This is **2.0.0** — breaking. Path layout changes, CLI gains subcommands.

### What breaks

1. **Output path.** `out/<runId>/<slug>/` → `out/<slug>/`. All writers in this repo go through the path helper, so internal code is fine. Downstream consumers (user's import scripts) may have hardcoded the run-id-prefixed path and will need updates.
2. **CLI shape.** `framework/cli.mjs` (and `run.sh`) gain a subcommand dispatcher. The implicit-crawl alias preserves the old positional form so `run.sh --display-name "Pendle" --type fixed_rate` keeps working.
3. **Slash command.** `/protocol-info:protocol-info --display-name ...` keeps working (it shells `run.sh`). The new subcommands are NOT exposed via the slash command in 2.0; users invoke them via `bash run.sh i18n pendle` directly. Slash-command surface for stage CLIs is a 2.x follow-up.

### What's preserved

- `manifest.json` schema, all prompts, all schemas, all fetchers, all normalizers — unchanged.
- `record.json` / `record.import.json` / `record.full.json` shapes — unchanged.
- ROOTDATA_API_KEY lookup, i18n model defaults, R1/R2 model defaults — unchanged.

### User migration story

First `protocol-info crawl` on 2.0:

1. `ensureRepo(out)` runs — `git init`, write `.gitignore`, set local-only user.
2. Existing `out/<runId>/...` directories: untouched, untracked, ignored by the new browser.
3. New record lands at `out/<slug>/`.

README adds a one-paragraph "upgrading from 1.x" note: "Old `out/2026*/` directories are no longer surfaced in the browser; remove them at your leisure with `rm -rf out/2026*/`. Your records start fresh on the new layout."

### Release split

Two PRs, two releases. Smaller blast radius per PR.

- **2.0.0** = layout flip + git layer + `crawl` auto-commit + browser refactor. Internal stage commits land but no new user-facing stage CLIs yet.
- **2.1.0** = the 7 stage CLIs (`i18n`, `get`, `set`, `history`, `diff`, `restore`, `refresh`). Builds on 2.0's foundation.

## Open questions for the implementation plan

(Things deliberately punted from this design that the implementation plan should pin down.)

- Exact format of the `--trailer "Run-Id: ..."` git trailer — needs to round-trip cleanly through `git log --format=...` so the browser can extract it.
- Whether `regenerate index.html` after every stage CLI call is too aggressive (it's a static file, but it does walk the tree). Possibly batch via `--no-html` flag for scripted use.
- Whether `refresh` should also accept `--all-subtasks` as shorthand for re-running all four. Probably yes; small addition.
- Whether `out/.runs/<runId>/` (the metadata-only run dir) should be auto-cleaned after N runs to prevent unbounded growth. Defer to ops.
