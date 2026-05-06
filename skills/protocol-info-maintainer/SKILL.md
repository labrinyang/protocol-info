---
name: protocol-info-maintainer
description: Focused sub-skill selected by protocol-info-router for maintaining an existing out/<slug> protocol-info record. Covers get/set/analyze, refresh, i18n, pdf-text, history/diff, and restore. Use after the router chooses the existing-record path. Do not use for new crawls, queue orchestration, token prices, or on-chain queries.
user-invocable: false
---

# Protocol-info existing-record maintainer

This is a focused sub-skill. If you arrived here directly and the request is a
new crawl or queue orchestration task, switch to the `protocol-info-router`
skill first.

The user wants to inspect or update an existing canonical
`out/<slug>/record.json`. Dispatch through the bundled
`/protocol-info:protocol-info` slash command. Do not edit `out/<slug>/*.json`
manually and do not replace this workflow with raw `WebFetch` / `WebSearch`.

## Workflow mapping

| What the user said | Invocation shape |
|---|---|
| "看一下/取出某个 key" / inspect a field | `get <slug> <jsonpath>` |
| "把某个 key 改成..." with an explicit value | `set <slug> <jsonpath> <json-value>` |
| "搜索/分析/核实某个 key" but not apply | `analyze <slug> <jsonpath> --query "<question>"` |
| "搜索并修改/应用到某个 key" | `analyze <slug> <jsonpath> --query "<question>" --apply` |
| "补翻/重翻已有记录" | `i18n <slug> --locales <locale-list|all>` |
| "刷新项目基础信息/团队/融资/审计" | `refresh <slug> <metadata|team|funding|audits>` |
| "查看某个 audit PDF 抽取文本" | `pdf-text <slug> <audit-index>` |
| "看历史/版本记录" | `history <slug>` |
| "看两个版本差异" | `diff <slug> [from] [to]` |
| "恢复到某个版本" | `restore <slug> <sha>` |

Write commands normalize deterministic fields, validate the full record,
invalidate stale i18n when source fields change, regenerate post-processed
artifacts, and commit only the scoped slug/assets inside `out/.git`.

## Clarification rules

Ask ONE short question, then act. Never ask more than one.

- If the slug is missing, ask for the slug.
- If an edit lacks a JSONPath or explicit JSON value, ask for the missing piece.
- If locale list is explicit, map literally. If locale list is vague, default to
  `zh_CN,en_US,ja_JP,ko_KR` and say that choice once.

## Dispatch examples

**"把 Pendle 现有记录再补翻韩文"**
```
/protocol-info:protocol-info i18n pendle --locales ko_KR
```

**"核实 pendle 的 fundingRounds, 先别改"**
```
/protocol-info:protocol-info analyze pendle fundingRounds --query "verify latest funding rounds"
```

**"搜索一下 pendle 的 audits 并应用"**
```
/protocol-info:protocol-info analyze pendle audits --query "verify latest public audits" --apply
```

**"恢复 pendle 到 abc1234"**
```
/protocol-info:protocol-info restore pendle abc1234
```

## After the command returns

- For read-only workflow commands, summarize the direct output.
- For write workflow commands, say whether it completed and mention that
  `out/<slug>/record.json` was updated or restored.
- Only investigate debug artifacts if the user asks or the command failed.
