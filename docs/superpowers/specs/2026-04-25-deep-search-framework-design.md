# Deep-Research Framework Design

**Date:** 2026-04-25
**Status:** Spec → next: writing-plans
**Project:** `protocol-info` → `framework/` + `consumers/protocol-info/` (monorepo)
**Target version:** 1.0.0 (after phase 9)

## 1. Goals

Turn the existing `protocol-info` crawler from "single big prompt" into a
**deep-research pipeline**: decompose-and-fan-out research, multi-source
evidence aggregation, per-field citations, and explicit gap signaling. Build
it as a **reusable framework** so future research projects (e.g., wallet
provider info, token-launch due diligence, L2 fact sheets, audit-firm
dossiers) plug in by writing a small adapter — not by forking.

### Explicit non-goals (this iteration)

- **Gap-loop (R3+ iteration).** Design hooks for it (gaps.json contains
  enough info to drive a future loop) but do not implement.
- **Multiple consumers shipping.** `protocol-info` is the only consumer
  for v1.0.0. The framework's API surfaces are designed for >1 consumer
  but only exercised by one.
- **Paid evidence sources.** Tier 1 only (RootData + DeFiLlama); Messari /
  Token Terminal explicitly deferred.
- **JSON Schema `$ref` cross-file resolution.** Slice schemas duplicate
  field definitions from `full.json`; a coherence-check script keeps them
  in sync.
- **TypeScript / build step / npm packages.** Strict zero-runtime-deps;
  ESM `.mjs`; Node stdlib only.

## 2. Approach

| Decision | Choice | Why |
|---|---|---|
| Repo shape | Monorepo (framework + consumer same repo) | Only 1 consumer; splitting now is premature. Later extraction is cheap. |
| Abstraction level | "Framework + adapter", not just protocol-info improvements | User chose B (Q2): future research projects plug in cheaply |
| Evidence sources | RootData + DeFiLlama; everything else via Claude WebSearch/WebFetch | Tier 1 only (Q3); audit-doc discovery happens via web research, not a dedicated GitHub fetcher |
| Subtask cuts | 4 (metadata / team / funding / audits) | A in Q4 |
| Subtask output shape | β: `{slice, findings, gaps}` | Only β delivers per-field citation, the deep-research hallmark |
| Framework boundary | Mid-thickness: orchestrator + subtask-runner + merger + i18n + fetcher-dispatcher in framework | β in Q6 |
| Language | Hybrid: thin bash entry + Node orchestrator | bash-jq spaghetti for β-output merging is a maintenance trap |
| R2 shape | Whole `record` (not fan-out), with no-regression guard at merge | 4× cost of R2 fan-out not justified; cheap mechanical guard handles "Claude over-edits" risk |
| Migration strategy | 9 incremental phases, 1 commit each | Risk-bounded; `run.sh` keeps running through phases 1-8 |

## 3. Architecture

```
protocol-info/
├── .claude-plugin/                     # unchanged
├── commands/protocol-info.md           # unchanged
├── skills/protocol-info-crawler/       # unchanged
├── run.sh                              # ≤50 lines after phase 9: argv + .env + exec node
│
├── framework/                          # generic deep-research framework
│   ├── cli.mjs                         # Node entry, exec'd by run.sh
│   ├── orchestrator.mjs                # R0 → R1 → R2 → i18n → export pipeline
│   ├── claude-wrapper.mjs              # spawn `claude -p`, schema-forced, retry, cost cap
│   ├── parallel-runner.mjs             # bounded promise queue
│   ├── fetcher-dispatcher.mjs          # parallel-call manifest fetchers → unified evidence
│   ├── subtask-runner.mjs              # render prompt → claude → parse {slice,findings,gaps}
│   ├── merger.mjs                      # N slices → full record + flat findings + gaps
│   ├── i18n-stage.mjs                  # generic i18n: manifest declares translatable fields
│   ├── schema-validator.mjs            # ← migrated from validate.mjs (zero-dep Draft-07)
│   ├── json-extract.mjs                # ← migrated from extract-json.mjs (balanced JSON)
│   └── schemas/
│       ├── findings.schema.json        # universal finding shape
│       ├── gaps.schema.json            # universal gap shape
│       └── consumer-manifest.schema.json
│
├── consumers/
│   └── protocol-info/
│       ├── manifest.json               # declares subtasks/fetchers/i18n/post-processing
│       ├── prompts/                    # all consumer-specific prompts moved here
│       │   ├── system.md
│       │   ├── metadata.user.md.tmpl
│       │   ├── team.user.md.tmpl
│       │   ├── funding.user.md.tmpl
│       │   ├── audits.user.md.tmpl
│       │   ├── reconcile.user.md.tmpl
│       │   ├── i18n.system.md
│       │   └── i18n.user.md.tmpl
│       ├── schemas/
│       │   ├── full.json               # complete EarnProtocolInfo (was earn-protocol-info.schema.json)
│       │   ├── metadata.slice.json
│       │   ├── team.slice.json
│       │   ├── funding.slice.json
│       │   ├── audits.slice.json
│       │   └── i18n.json
│       ├── fetchers/
│       │   ├── rootdata.mjs            # ← from preprocess-rootdata.mjs
│       │   └── defillama.mjs           # NEW
│       └── post/
│           ├── locale-map.mjs          # ← from dashboard_locale_for bash function
│           └── dashboard-export.mjs    # ← from export_dashboard_record bash function
│
├── tests/                              # NEW
│   ├── run.mjs                         # custom test runner (zero-dep)
│   └── ...                             # *.test.mjs files
├── scripts/                            # NEW
│   ├── check-slice-coherence.mjs       # validates slice ⊆ full
│   └── check-all.mjs                   # runs slice-coherence + tests + bash -n
├── docs/
│   └── superpowers/specs/              # this file lives here
└── out/                                # unchanged
```

**Constraints:**

- **Zero runtime dependencies.** Node stdlib only (`fs/promises`, `child_process`, `url`, `crypto`, `path`). No `package.json` for runtime. Dev-time tooling may have devDeps but that doesn't ship to plugin users.
- **ESM `.mjs`.** No TypeScript compile, no bundler. File = module.
- **Manifest is JSON, not DSL.** Logic lives in modules referenced from manifest.
- **Plugin / standalone CLI entry unchanged.** `/protocol-info ...` and `./run.sh ...` UX identical pre/post migration.

**Estimated module sizes** (lines, post-migration):

| Module | LOC |
|---|---|
| framework/orchestrator.mjs | ~200 |
| framework/claude-wrapper.mjs | ~80 |
| framework/parallel-runner.mjs | ~30 |
| framework/fetcher-dispatcher.mjs | ~50 |
| framework/subtask-runner.mjs | ~100 |
| framework/merger.mjs | ~80 |
| framework/i18n-stage.mjs | ~150 |
| framework/schema-validator.mjs | ~150 (unchanged) |
| framework/json-extract.mjs | ~50 (unchanged) |
| consumer post-processing | ~100 |
| run.sh | ~50 |
| **Total framework + consumer** | **~1040** |

vs. current `run.sh` (1100) + `preprocess-rootdata.mjs` (~600) + helpers ≈ **~1700**.
**~40% reduction in code volume + every module single-responsibility & testable.**

## 4. Data Flow

```
                     CLI args
                          │
              { slug, displayName, type, hints, ... }
                          │
                          ▼
               ┌──────────────────┐
               │   orchestrator   │
               └─────────┬────────┘
                         │
              ┌──────────┼──────────┐
              ▼                     ▼
         R0 fetchers          R1 fan-out (parallel × 4)
         ─────────            ──────────
         rootdata.mjs ┐
         defillama.mjs┼──▶ evidence packet ──▶ subtask metadata ─┐
                      │                        team              │
                      │                        funding           │── slices + findings + gaps
                      │                        audits            │
                      └──────────┬─────────────────────────────────┘
                                 │
                                 ▼
                              merger
                                 │
                                 ▼
                    merged record + findings[] + gaps[]
                                 │
                       ┌─────────┴──────────────┐
                       ▼                        │
            R2 reconcile (conditional)          │
            ─────────────                       │
            • evidence diff (RootData)          │
            • re-research findings.confidence<0.7│
            • output: revised whole record      │
            • merger applies "no-regression"    │
              guard against R1                  │
                       │                        │ (if i18n enabled)
                       ▼                        ▼
                 record.json              i18n-stage (Haiku, per-locale)
                 findings.json            ────────────────
                 gaps.json                Translates manifest.translatable_fields
                                                │
                                                ▼
                                  consumer post-processing
                                  ────────────
                                  dashboard-export.mjs
                                                │
                                                ▼
                                  record.full.json + record.import.json
```

### Key data structures

**Evidence packet (R0 → R1 input):** Top-level keys per fetcher; each fetcher
defines its own inner shape. Framework only owns top-level merging.

```json
{
  "fetchers_run": ["rootdata", "defillama"],
  "rootdata": { /* fetcher-defined */ },
  "defillama": { /* fetcher-defined */ },
  "fetched_at": "2026-04-25T..."
}
```

**Subtask output:**

```json
{
  "slice": { /* shape of consumer's slice schema */ },
  "findings": [ { "field": "...", "value": ..., "source": "...", "confidence": 0.92, "method": "..." } ],
  "gaps": [ { "field": "...", "reason": "...", "tried": [...] } ]
}
```

`stage` and `subtask` are added to each finding/gap by the framework after parse;
Claude does not produce them.

**Merger output:**

```json
{
  "record": { /* full schema */ },
  "findings": [ /* flat, accumulated, framework-tagged with stage+subtask */ ],
  "gaps": [ /* flat, accumulated */ ],
  "subtask_meta": {
    "metadata": { "cost_usd": 0.18, "turns": 4, "session_id": "..." },
    "team": { ... }, "funding": { ... }, "audits": { ... }
  }
}
```

**Final on-disk artifacts (per slug):**

| File | Content | Producer |
|---|---|---|
| `record.json` | merged + R2 record (crawler invariant, schema-validated) | merger |
| `findings.json` | accumulated findings, per-field provenance | merger |
| `gaps.json` | accumulated gaps with stage tags | merger |
| `record.full.json` | inline-i18n version | post (dashboard-export) |
| `record.import.json` | dashboard envelope, per-locale array | post (dashboard-export) |
| `meta.json` | r0/r1/r2/i18n stage telemetry (cost, turns, fetcher status, subtask split) | orchestrator |
| `_debug/r1/<subtask>.envelope.json` | raw Claude envelope per R1 subtask | claude-wrapper |
| `_debug/r2.envelope.json` | raw Claude envelope for R2 | claude-wrapper |
| `_debug/i18n/<locale>.json` | per-locale translated subset | i18n-stage |
| `_debug/i18n/<locale>.envelope.json` | per-locale Haiku envelope | i18n-stage |
| `_debug/<stage>.stderr.log` | per-stage stderr (only on failure) | wrapper |

## 5. Schema Design

### Framework-universal schemas

**`framework/schemas/findings.schema.json`** — array of:

```json
{
  "field": "JSON path, e.g. members[0].oneLiner",
  "value": "any JSON type, equals record value at that path",
  "source": "primary URL, format: uri",
  "confidence": "0.0–1.0",
  "method": "≤200 char, e.g. 'X bio + LinkedIn cross-check'",
  "supporting_sources": ["≤5 corroborating URLs"]
}
```

**`framework/schemas/gaps.schema.json`** — array of:

```json
{
  "field": "JSON path",
  "reason": "≤500 char",
  "tried": ["≤10 method/source descriptions"]
}
```

### Consumer schemas (`consumers/protocol-info/schemas/`)

- `full.json` — complete EarnProtocolInfo (literally the current
  `earn-protocol-info.schema.json` with `establishment` range adjusted to
  `1900–2030` per v0.4.0).
- `metadata.slice.json` — strict subset: slug, provider, displayName, type,
  description, tags, establishment, providerWebsite, providerXLink,
  providerDiscordLink.
- `team.slice.json` — `members` only.
- `funding.slice.json` — `fundingRounds` only.
- `audits.slice.json` — `audits` only.

**Slice schemas duplicate field definitions from `full.json`.** No `$ref`
cross-file resolution (zero-dep validator doesn't support it; implementing
`$ref` properly costs ~150 lines for marginal gain). Drift is prevented by
`scripts/check-slice-coherence.mjs` (~30 lines), run in pre-push and CI.

### Per-call union schema (runtime-constructed)

`subtask-runner.mjs` builds the per-call schema by inlining slice +
findings + gaps:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["slice", "findings", "gaps"],
  "properties": {
    "slice": { /* inlined from team.slice.json */ },
    "findings": { /* inlined from findings.schema.json */ },
    "gaps": { /* inlined from gaps.schema.json */ }
  }
}
```

`findings` and `gaps` are required arrays; empty array means "this subtask
had nothing to add", explicitly distinguished from "Claude forgot the field".

### R2 schema

R2 returns the whole record, not a slice:

```json
{
  "required": ["record", "findings", "gaps"],
  "properties": {
    "record": { /* inlined full.json */ },
    "findings": { /* findings */ },
    "gaps": { /* gaps */ }
  }
}
```

### No-regression guard

Merger applies this rule when integrating R2 output into R1 merged record:

- For each field path `P` where R2 produces a value:
  - If R1 had a finding at `P` with `confidence > 0.85` AND R2's finding at
    `P` has `confidence ≤ R1.confidence`: **reject R2's value, keep R1's**.
    Log to gaps.json with reason `"r2_regression_suppressed"`.
  - If R1 had no finding at `P` (Claude added it in R2): accept.
  - Otherwise (R2 has higher confidence or R1 was low confidence): accept R2.

## 6. Manifest Design

**`consumers/protocol-info/manifest.json`** — declarative consumer config.

```json
{
  "$schema": "../../framework/schemas/consumer-manifest.schema.json",
  "name": "protocol-info",
  "version": "1.0.0",

  "schemas": { "full": "./schemas/full.json" },

  "fetchers": [
    { "name": "rootdata",   "module": "./fetchers/rootdata.mjs",   "required_env": ["ROOTDATA_API_KEY"], "optional": true },
    { "name": "defillama",  "module": "./fetchers/defillama.mjs",  "required_env": [], "optional": true }
  ],

  "system_prompt": "./prompts/system.md",

  "subtasks": [
    {
      "name": "metadata",
      "prompt": "./prompts/metadata.user.md.tmpl",
      "schema_slice": "./schemas/metadata.slice.json",
      "max_turns": 15, "max_budget_usd": 0.50,
      "evidence_keys": ["rootdata.anchors", "rootdata.validated_overrides", "defillama.category", "defillama.chains"]
    },
    {
      "name": "team",
      "prompt": "./prompts/team.user.md.tmpl",
      "schema_slice": "./schemas/team.slice.json",
      "max_turns": 25, "max_budget_usd": 0.80,
      "evidence_keys": ["rootdata.member_candidates"]
    },
    {
      "name": "funding",
      "prompt": "./prompts/funding.user.md.tmpl",
      "schema_slice": "./schemas/funding.slice.json",
      "max_turns": 15, "max_budget_usd": 0.50,
      "evidence_keys": ["rootdata.api_funding"]
    },
    {
      "name": "audits",
      "prompt": "./prompts/audits.user.md.tmpl",
      "schema_slice": "./schemas/audits.slice.json",
      "max_turns": 20, "max_budget_usd": 0.50,
      "evidence_keys": []
    }
  ],

  "reconcile": {
    "enabled": true,
    "prompt": "./prompts/reconcile.user.md.tmpl",
    "max_turns": 10, "max_budget_usd": 0.50,
    "trigger_when": {
      "min_finding_confidence": 0.7,
      "evidence_diff_severity": ["medium", "high"]
    }
  },

  "i18n": {
    "enabled": true,
    "model_default": "claude-haiku-4-5-20251001",
    "max_budget_usd_per_call": 0.10,
    "system_prompt": "./prompts/i18n.system.md",
    "user_prompt": "./prompts/i18n.user.md.tmpl",
    "schema": "./schemas/i18n.json",
    "translatable_fields": ["description", "members[].memberPosition", "members[].oneLiner"],
    "locale_catalog": [
      { "code": "bn", "name_zh": "孟加拉语", "name_en": "Bengali" },
      { "code": "de", "name_zh": "德语", "name_en": "German" }
      /* ... 19 entries total */
    ]
  },

  "post_processing": [
    {
      "name": "dashboard-export",
      "module": "./post/dashboard-export.mjs",
      "config": {
        "envelope_version": "1.0",
        "locale_map_module": "./post/locale-map.mjs",
        "source_locale_dashboard_code": "en",
        "strip_fields": ["sources"]
      }
    }
  ],

  "output": {
    "record_filename": "record.json",
    "findings_filename": "findings.json",
    "gaps_filename": "gaps.json",
    "meta_filename": "meta.json",
    "full_filename": "record.full.json",
    "import_filename": "record.import.json",
    "debug_dir": "_debug"
  }
}
```

**Notes:**
- `evidence_keys` are jq-style paths into the evidence packet; framework
  injects only matching subtrees into each subtask's prompt → smaller
  prompts, less Claude distraction.
- `reconcile.trigger_when` — R2 is conditional. Skip R2 entirely when neither
  trigger fires (saves ~$0.50/protocol when R1 already produced high-confidence
  output and evidence diffs are clean).
- `translatable_fields` use bracket notation (`members[].memberPosition`)
  for "for-each" selectors. Adding a new translatable field is a one-line
  manifest change.
- `fetchers[].optional: true` means a fetcher failure or missing env does
  not abort the pipeline. R1 simply runs without that source's evidence.
- Manifest is validated against `framework/schemas/consumer-manifest.schema.json`
  on framework startup; bad manifests fail fast with a clear message.

## 7. Error / Cost / Retry

**Per-stage budget caps** (manifest-driven, framework-enforced):

| Stage | Cost ceiling | Turn ceiling | Notes |
|---|---|---|---|
| R0 fetcher (each) | n/a (no LLM) | n/a | 10 s network timeout, 1 retry with exponential backoff (500 ms → 1.5 s) |
| R1 metadata | $0.50 | 15 | manifest-defined |
| R1 team | $0.80 | 25 | members research is the most expensive subtask |
| R1 funding | $0.50 | 15 | |
| R1 audits | $0.50 | 20 | audit-doc discovery often takes more turns |
| R2 reconcile | $0.50 | 10 | conditional on trigger |
| i18n (per locale) | $0.10 | 3 | Haiku, schema-forced |
| **Total ceiling per protocol** | ~$3.40 | — | R1 $2.30 + R2 $0.50 + i18n max $1.90 (19 locales) |

**Retry policy:**
- 5xx / connection timeout / 529 overloaded → 1 retry with exponential
  backoff (2 s, 5 s).
- 4xx / max-turns / max-budget exceeded → no retry, classify as failure.
- JSON parse failure → 1 retry with stricter prompt suffix
  (`Your previous output was not valid JSON; emit JSON only matching the
  schema exactly.`).

**Per-subtask isolation** (R1 fan-out's safety net):
- 1 subtask failure does NOT abort siblings.
- Failed subtask's slice = `{}`; merger writes a gap entry
  `{ field: "<subtask>", reason: "subtask_failed: <error>", stage: "r1" }`.
- Final classification:
  - 4/4 subtasks succeed → normal path → schema validate
  - 1–3/4 succeed → partial record + `status: SCHEMA_FAIL`, gaps.json shows
    which subtask(s) failed
  - 0/4 succeed → `status: CRAWL_FAIL`, no record.json (avoid misleading
    downstream consumers)

**Pipeline abort conditions (early exit):**
- Manifest fails schema → exit 2 (config error)
- 0/4 R1 subtasks succeed → exit 1 (no usable data)
- All optional fetchers fail → continue (single-round mode), warn to stderr
- `claude` CLI not on PATH → exit 127 (env error)

**Cost aggregation:** subtask-runner returns `{cost_usd, turns}`;
orchestrator accumulates into `meta.json` per stage. Failed subtasks still
record cost (knowing what we burned matters).

## 8. Testing Strategy

**Pure-function unit tests** (no Claude required):
- `framework/schema-validator.mjs` — feed schema + valid/invalid instances,
  assert pass/fail.
- `framework/json-extract.mjs` — feed noisy strings, assert extracted JSON
  parses.
- `framework/merger.mjs` — feed fake subtask outputs, assert merged record
  shape and findings/gaps accumulation.
- `framework/parallel-runner.mjs` — assert concurrency cap respected via
  timing harness.
- `consumers/protocol-info/post/locale-map.mjs` — assert
  `dashboard_locale_for("zh_CN") === "zh-cn"` and the full mapping table.
- `consumers/protocol-info/post/dashboard-export.mjs` — feed fake record +
  translations, assert `record.import.json` shape.

**Integration tests** (stub-claude pattern from existing v0.3.0 smoke
tests):
- `framework/claude-wrapper.mjs` invocation with a stub `claude` binary.
- End-to-end pipeline with a multi-purpose stub that returns appropriate
  envelope shape based on `--json-schema` content (R1 subtask vs R2 vs i18n).

**Untestable in CI** (manual verification):
- Claude prompt quality (output quality changes with prompt changes).
- Real RootData / DeFiLlama API stability (occasional flakes; runtime retry
  handles these, no test coverage needed).

**Test runner** (zero-dep, custom):
- `tests/run.mjs` — discovers `tests/**/*.test.mjs`, runs each as an async
  function, accumulates pass/fail, exits non-zero if any fail.
- ~80 lines; no jest/vitest dependency.
- Future migration to vitest is acceptable (dev-only dep, no runtime impact).

**Pre-push / CI script** — `scripts/check-all.mjs`:
1. `node scripts/check-slice-coherence.mjs` — slice schemas vs full schema.
2. `node tests/run.mjs` — units + stub-claude integration.
3. `bash -n run.sh` — bash syntax.

## 9. Migration Phases

Nine commits, each independently reversible. Old `run.sh` keeps running
through phases 1–8.

| # | Phase | Deliverables | Smoke test | Risk |
|---|---|---|---|---|
| 1 | **Bootstrap** | `framework/{claude-wrapper,parallel-runner,json-extract,schema-validator}.mjs`; migrate existing `extract-json.mjs` + `validate.mjs` | `tests/run.mjs` unit suite passes | Low — additive |
| 2 | **Fetcher framework** | `preprocess-rootdata.mjs` → `consumers/protocol-info/fetchers/rootdata.mjs` (interface adjusted); add `defillama.mjs`; add `framework/fetcher-dispatcher.mjs`; `run.sh` calls dispatcher | Run a slug; evidence packet contains both rootdata + defillama subtrees | Low — interface swap |
| 3 | **R1 single-task in Node** | `framework/subtask-runner.mjs` (α-shape, no findings/gaps); wraps existing big prompt; `run.sh` delegates R1 but pipeline shape unchanged | Run same slug; record.json substantially equivalent to phase-2 baseline (within Claude variance) | Med — language migration |
| 4 | **Fan-out** | 4 prompt templates + 4 slice schemas; subtask-runner dispatches in parallel via parallel-runner; `framework/merger.mjs` combines | Same slug; 4-subtask version vs phase-3 baseline; field fill-rate equal or higher | **High** — prompt-quality critical |
| 5 | **β output (findings + gaps)** | Union schema (slice + findings + gaps); prompts request findings/gaps; merger accumulates → `findings.json` + `gaps.json` | Inspect findings.json: plausible per-field source/confidence | Med — prompt design |
| 6 | **R2 in Node + no-regression guard** | `reconcile.user.md.tmpl`; R2 via subtask-runner returning whole `record`; merger applies confidence guard | Slug with known R1 gaps: R2 should fill them; field with high R1 confidence not regressed | Med |
| 7 | **i18n in Node** | `framework/i18n-stage.mjs` replaces bash `i18n_dispatch`; `manifest.translatable_fields` drives selection | `--i18n zh_CN,ja_JP` produces same per-locale sidecars as v0.4.0 | Low |
| 8 | **Export in Node** | `consumers/protocol-info/post/{locale-map,dashboard-export}.mjs` replace bash functions | `record.import.json` byte-equivalent (modulo timestamp) to v0.4.0 output | Low |
| 9 | **`run.sh` shrink + 1.0.0** | `run.sh` ≤ 50 lines; remove all migrated bash; bump version; update README/CHANGELOG | Plugin install + slash command + standalone CLI all work | Low |

**Cadence (calendar weeks):**
- Week 1: phases 1–3 (foundation + functional equivalence)
- Week 2: phases 4–5 (fan-out + β; biggest value tranche)
- Week 3: phases 6–9 (R2/i18n/export wrap-up + 1.0.0)

**Each phase requires before commit:**
1. `node tests/run.mjs` all green
2. `bash -n run.sh` passes
3. At least one real-slug end-to-end run, manually compared against
   previous phase's output
4. Commit message format: `feat(framework): phase N - <deliverable>`
5. If end-to-end is broken at the end of a phase: revert, do not merge

## 10. Open Questions

These do not block design completion but need resolution before / during
implementation:

1. **Dashboard's authoritative 21-locale list.** v0.4.0 ships 19; the
   missing 2 codes are unknown. Awaiting source from the dashboard team.
   Workaround: `dashboard_locale_for` continues returning unknown codes
   verbatim through its fallback rule.
2. **Manifest validator implementation depth.** First pass: validate that
   referenced files exist + JSON parses. Future: deep schema-validity
   check on each referenced schema file. Phase 1 deliverable.
3. **Whether to ship a `consumer-template/` scaffold** for future
   consumers. Deferred — wait for the second consumer to actually need
   one before designing the template.

## 11. Reference: User-Facing Surface (Unchanged)

Plugin install:
```
/plugin marketplace add labrinyang/protocol-info
/plugin install protocol-info@labrinyang
```

Slash command (commands/protocol-info.md unchanged):
```
/protocol-info --display-name "Pendle" --type fixed_rate --i18n all
```

Standalone CLI:
```bash
./run.sh --display-name "Pendle" --type fixed_rate --i18n zh_CN,ja_JP
```

The `run.sh` shim transparently `exec`s `framework/cli.mjs`. CLI flags
unchanged. Output paths unchanged (`record.json`, `record.full.json`,
`record.import.json`, `meta.json`, `_debug/`). New artifacts:
`findings.json`, `gaps.json` per slug.

---

## Appendix A — Decision Log (from brainstorming)

| Q | Decision | Alternatives rejected |
|---|---|---|
| Q1: Which directions? | #1 fan-out + #2 multi-source (#3 gap-loop deferred) | All three at once (overkill); fan-out alone (no value-add to evidence); evidence alone (doesn't fix monolithic prompt) |
| Q2: Abstraction level | B (reusable framework) | A (protocol-info-only — no future leverage); C (scoped + extension points — middle-ground compromise that user explicitly rejected) |
| Q3: Evidence sources | Tier 1: RootData + DeFiLlama; everything else via Claude WebSearch/WebFetch | GitHub fetcher (motive was audit-doc discovery, but better via web); Messari/Token Terminal (paid, low ROI for our schema) |
| Q4: Subtask cuts | 4 (metadata / team / funding / audits) | 5 with separate `socials` (over-decomposed); 3 with `team`+`metadata` merged (token-saving but quality hit) |
| Q5: Subtask output | β (slice + findings + gaps) | α (no citations — fails deep-search promise); γ (sidecar findings — pragmatic middle, but β commits to the deep-research feature properly) |
| Q6: Framework boundary | β (orchestrator + subtask-runner + fetcher-dispatcher + merger + i18n in framework) | α (thin framework — pipeline shape leaks into every consumer); γ (manifest DSL — premature abstraction) |
| Q7: Language | Hybrid (bash entry + Node orchestrator) | Bash-only (jq spaghetti for β output); Node-only (loses the familiar `./run.sh` entry, no real gain) |
| Slice schemas | Duplicate field definitions; ship coherence-check script | `$ref` cross-file (zero-dep validator doesn't support; ~150 LoC investment for marginal gain) |
| R2 shape | Whole `record` + no-regression guard at merge | R2 fan-out (4× cost without quality justification) |

## Appendix B — Memory Notes

Saved to `/Users/labrinyang/.claude/projects/-Users-labrinyang-projects-protocol-info/memory/feedback_commit_dont_hedge.md`: when I have a strong opinion on a technical decision, commit directly instead of presenting A/B/C and asking. User confirmed this preference explicitly multiple times this session.
