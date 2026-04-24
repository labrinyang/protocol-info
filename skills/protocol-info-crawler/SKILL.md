---
name: protocol-info-crawler
description: Use when the user wants to gather metadata for a DeFi yield/earn protocol into a schema-validated EarnProtocolInfo record — e.g., "调研 Pendle 的项目概述", "抓一份 Morpho 的团队 + 融资信息", "批量爬这几个协议的 earn 信息", "给 earn 仪表盘录入 Aave 的 protocol-info", "翻译一下 Lido 的记录成日语", or English equivalents ("crawl protocol info for X", "build an EarnProtocolInfo record for Y"). Do NOT use for on-chain queries, price feeds, token quotes, or generic web research.
---

# Protocol-info crawler dispatcher

The user wants a schema-compliant `EarnProtocolInfo` record for a DeFi earn/yield/staking protocol. The bundled `/protocol-info` slash command does the end-to-end crawl:

1. Round 1 — Claude web search → strict-schema JSON
2. RootData API (if `ROOTDATA_API_KEY` set) — structured evidence, in parallel
3. Round 2 — resume session with API evidence, cross-check
4. Validate — JSON Schema pass/fail
5. i18n (optional) — Haiku translates `description` + `members[].{memberPosition, oneLiner}` to selected locales

## Your job

Translate the user's natural language into **one** `/protocol-info` invocation. Do not shell out to `run.sh` directly and do not substitute `WebFetch` / `WebSearch` — the whole point of this tool is schema-forced output + RootData reconciliation + Haiku i18n.

## Intent → flag mapping

| What the user said | Flag |
|---|---|
| Protocol's branded display name | `--display-name "..."` **(required)** |
| "simple earn" / 纯 earn / Aave-Compound 风格借贷 / Yearn 风格 vault | `--type simple_earn` |
| "fixed rate" / "yield trading" / "PT/YT" / 明确提到 Pendle 自己 | `--type fixed_rate` |
| "liquid staking" / "staking" / "LST" / "LRT" | `--type staking` |
| "vault aggregator" / "curator model" / Morpho/Spectra 这种混合形态 | **ask** — 这类混合形态不要自动映射 |
| Custom kebab slug the user provided | `--slug <kebab>` |
| Extra context (chain, category, focus) | `--hints "..."` |
| Explicit RootData project id | `--rootdata-id <N>` |
| Multiple protocols in one message | `--batch` separator between each group |
| "全部翻译" / "translate all" / "19 种语言" | `--i18n all` |
| Specific locales listed (e.g. "中日英") | `--i18n zh_CN,ja_JP,en_US` |
| "不要翻译" / "skip i18n" / no mention | `--i18n none` (be explicit so it doesn't prompt) |
| ≥3 providers, 或用户显式说 "快一点" / "并发" | `--parallel min(N_providers, 4)`(默认保守:2 个 provider 仍串行,用户不说就不加并发) |

### Locale code cheat sheet

`bn` 孟加拉 · `de` 德 · `en_US` 英(美) · `es` 西 · `fr_FR` 法 · `hi_IN` 印地 · `id` 印尼 · `it_IT` 意 · `ja_JP` 日 · `ko_KR` 韩 · `pt` 葡 · `pt_BR` 葡(巴) · `ru` 俄 · `th_TH` 泰 · `uk_UA` 乌 · `vi` 越 · `zh_CN` 简中 · `zh_HK` 繁中(港) · `zh_TW` 繁中(台)

## Clarification rules

Ask ONE short question, then act. Never ask more than one.

- **Type ambiguous**(用户只给了名字 / 只给了映射表里标 "ask" 的同义词 / 知名协议里有同名但不同类型的分支): ask `"这是 fixed-rate / simple-earn / staking 哪种?"`。**宁可问一次也不自动映射**。
- **Name ambiguous** ("抓一下 Sky"): ask `"要抓的是哪个 Sky?"` — 给一行 sky.money vs sky network 的区分。
- **Locale list 明确给出**(比如"中日英"): 按字面映射(`zh_CN,ja_JP,en_US`)。
- **Locale 模糊** ("翻译成几种主流语言"): 默认 `zh_CN,en_US,ja_JP,ko_KR`,一句话告知用户"我按主流 4 种翻译了,如果要别的或全部 19 种请说"。

## Dispatch examples

**"帮我抓一份 Pendle 的 protocol-info,翻成中日英"**
```
/protocol-info --display-name "Pendle" --type fixed_rate --i18n zh_CN,ja_JP,en_US
```

**"批量爬 Morpho 和 Aave 的 earn 信息,不用翻译"**
```
/protocol-info --parallel 2 --i18n none --batch --display-name "Morpho" --type simple_earn --batch --display-name "Aave" --type simple_earn
```

**"给我做一份 Lido 的项目概述"** — ambiguous type, ask first. After user says "staking":
```
/protocol-info --display-name "Lido" --type staking --i18n none
```

**"把刚才跑出来的 Pendle 记录再补翻一下韩文"** — there's no "re-run i18n for existing record" flag; the whole crawler would re-run. Tell the user this is a known limitation: easiest is `/protocol-info --display-name "Pendle" --type fixed_rate --i18n ko_KR` which will rebuild the record and add Korean. If they want to preserve the existing record exactly, they should manually edit `out/<ts>/<slug>/record.full.json`'s `.i18n` field.

## After the command returns

The `/protocol-info` command itself already handles summary/error reporting. Don't duplicate that work. Only step in if:

- The user asks for interpretation of a `SCHEMA_FAIL` or partial `i18n` failure
- The user wants to edit the output before DB import
- The user wants to re-run with different args

## Do not

- Do not reimplement the crawl with raw `WebFetch` / `WebSearch` — you'll produce a non-schema-compliant record.
- Do not translate manually when `--i18n` is requested — Haiku with schema-forced output is the whole point.
- Do not modify `out/<ts>/<slug>/*.json` files yourself unless the user explicitly asks.
- Do not pre-validate arguments — `run.sh` errors cleanly on missing required flags; don't gate on your own checks.
- Do not assume `ROOTDATA_API_KEY` is set. Round 1 alone is still useful. Only mention the env var if the user asks why Round 2 didn't run, or if they explicitly want API reconciliation and it's missing.
