# protocol-info crawler

Local batch tool that produces `EarnProtocolInfo` JSON records via `claude -p`
headless mode with WebFetch + WebSearch. Outputs are hand-reviewed and then
imported into the dashboard MongoDB via the existing
`earn-protocol-info.controller.ts` CRUD endpoints. The `earn` service itself is
untouched — it will just read the collection once records land.

## Directory layout

```
script/protocol-info/
├── README.md                              # this file
├── run.sh                                 # batch driver
├── validate.mjs                           # zero-dep schema validator
├── providers.json                         # provider registry (edit freely)
├── prompts/
│   ├── system.md                          # research rules + output contract
│   └── user.md.tmpl                       # per-provider template
├── schema/
│   └── earn-protocol-info.schema.json     # JSON Schema (superset of entity)
└── out/                                   # generated records + debug logs
    └── <YYYYMMDDTHHMMSSZ>/                # timestamped run directory
        ├── <slug>.json
        ├── <slug>.raw.json
        ├── <slug>.stderr.log
        └── summary.tsv
```

## Prerequisites

| Tool                       | Use                         |
| -------------------------- | --------------------------- |
| `claude` CLI (Claude Code) | Headless LLM invocation     |
| `jq`                       | JSON templating in `run.sh` |
| `node` (≥ 18)              | `validate.mjs`              |

`WebFetch` + `WebSearch` must be available in your Claude Code install — they
are on by default.

## Quick start

```bash
git clone <repo-url>
cd protocol-info

# One provider (fastest way to eyeball quality)
./run.sh pendle

# Print the rendered prompt without calling Claude
./run.sh --dry-run pendle

# Full batch over providers.json
./run.sh

# Pin a specific model / raise turn budget / cap per-provider spend
./run.sh --model sonnet --max-turns 40 --max-budget 2.00 pendle morpho ethena
```

Outputs land in `out/<YYYYMMDDTHHMMSSZ>/` (a new timestamped subdirectory per
run, so previous results are never overwritten). The last printed block is a
summary table:

```
slug    status       members  funding  audits  schema
pendle  OK           3        2        4       pass
morpho  OK           3        3        17      pass
lista   SCHEMA_FAIL  2        1        15      fail
```

## Schema contract

`schema/earn-protocol-info.schema.json`

Per decision:

- **`slug` == `provider`** (one record per provider).
- **`status`** is always `"draft"` on crawl. Promote to `"active"` via the
  dashboard after human review.

## Review → import workflow

1. `./run.sh` → inspect `out/<run>/summary.tsv` (the exact path is printed at the end).
2. For each `out/<run>/<slug>.json`:
   - Sanity-check the description, members, funding rounds, and audits.
   - Verify every member is a real person — LinkedIn / Crunchbase / verified X.
     Remove fabricated entries; prefer `members: []` over fiction.
   - Patch any missing links by hand; re-run `node validate.mjs out/<run>/<slug>.json`
     to confirm.
3. Before DB insert:
   - Remove `providerWebsite`, `providerXLink`, `providerDiscordLink`, `sources`
     (the current entity doesn't accept them). A follow-up task will extend the
     entity.
   - `jq 'del(.providerWebsite, .providerXLink, .providerDiscordLink, .sources)'`
4. `POST` each cleaned record to the dashboard's
   `earn-protocol-info.controller.ts` create endpoint.

## Editing `providers.json`

Add, remove, or rename entries freely. Each entry:

```jsonc
{
  "slug": "pendle", // must be unique, kebab-case, equal to provider
  "provider": "pendle", // must match EProvider enum in server-service-earn/src/common/index.ts
  "displayName": "Pendle",
  "type": "fixed_rate", // fixed_rate | simple_earn | staking
  "hints": "Free-form note fed into the prompt. Optional."
}
```

## Why claude -p and not a pure curl pipeline?

Team/member data lives across dozens of pages (official about page, governance
forum, LinkedIn, Crunchbase, podcast bios). Hand-rolling extractors per
provider is high-maintenance and brittle. Delegating discovery + extraction to
Claude with explicit citation requirements gives us a 1-script solution that
survives website redesigns. The trade-off is non-determinism across runs —
mitigated by mandatory human review before DB import.
