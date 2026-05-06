---
name: protocol-info-router
description: Main router skill for the protocol-info plugin. Use for any request about DeFi EarnProtocolInfo records, protocol-info crawls, existing out/<slug> maintenance, i18n, audit PDF text, history/diff/restore, long batch queues, stuck/background crawls, or plugin workflow selection. It chooses the focused protocol-info sub-skill before dispatching. Do not use for unrelated DeFi questions, token prices, on-chain analytics, or generic web research.
argument-hint: "<protocol-info crawl, edit, or batch request>"
---

# Protocol-info skill router

Use this as the main skill entry point for protocol-info plugin work. First
classify the user's intent, then invoke exactly one focused sub-skill unless the
task truly combines multiple concerns.

This skill is intentionally named `protocol-info-router` so it does not shadow
the existing `/protocol-info:protocol-info` slash command from
`commands/protocol-info.md`.

## Choose A Sub-Skill

| Intent | Invoke |
|---|---|
| Create or recrawl one or more protocol records from scratch | `protocol-info:protocol-info-crawler` |
| Inspect or modify an existing `out/<slug>/record.json`; run `get`, `set`, `analyze`, `refresh`, `i18n`, `pdf-text`, `history`, `diff`, or `restore` | `protocol-info:protocol-info-maintainer` |
| Coordinate long queues, background runs, throughput, completion notifications, stuck crawls, or killed batches | `protocol-info:protocol-info-batch-operator` |

If the user mixes concerns, choose the sub-skill for the immediate action. For
example, "batch crawl these protocols and don't waste idle time between runs"
uses the batch operator; "refresh audits for pendle" uses the maintainer.

## Dispatch Rules

- Prefer the bundled `/protocol-info:protocol-info` slash command over shelling
  out to `run.sh`.
- Do not substitute raw `WebFetch` / `WebSearch` for protocol-info crawl,
  analyze, refresh, or i18n workflows.
- Do not manually edit `out/<slug>/*.json`; use the workflow commands routed by
  the selected sub-skill.
- Ask at most one short clarification question when the selected sub-skill says
  required information is missing.

## Negative Scope

Do not use protocol-info skills for unrelated DeFi research, on-chain state,
token quotes, portfolio analysis, or generic web browsing. Those are not
EarnProtocolInfo record workflows.
