# protocol-info

[English](README.md) | 简体中文

`protocol-info` 是一个 Claude Code 插件，也可以作为独立 CLI 使用。它用于调研 DeFi earn/yield/staking 协议，并生成通过 JSON Schema 校验的 `EarnProtocolInfo` JSON。

它会以 headless 模式调用 Claude，从 RootData、DeFiLlama 等可选 fetcher 获取结构化证据，按字段合并和对账，校验最终记录，并可选择用 Haiku 翻译 19 个 locale 的字段。

输出应先人工审核，再通过 dashboard 的 `earn-protocol-info` import endpoint 导入。

## 适用场景

当你需要可重复的协议调研管线时，使用本项目：

- 协议简介、标签、官网、X、Discord 链接
- 成立年份
- 公开团队成员、职位、社媒链接、短 bio
- 融资轮次、投资方、金额、估值、日期
- 审计报告、审计方、范围、报告链接、扫描时间
- 字段级来源、未解决 gap、R2 改动审计
- 可选的 dashboard 多语言导入输出

它不是全自动发布系统。Crawler 负责产出可审核记录；团队、融资、审计信息仍应由人工复核后再进入生产。

## 作为 Claude Code 插件安装

推荐安装方式：

```text
/plugin marketplace add labrinyang/protocol-info
/plugin install protocol-info@labrinyang
```

可选 RootData 配置：

```bash
mkdir -p ~/.config/protocol-info
echo "ROOTDATA_API_KEY=sk-..." > ~/.config/protocol-info/.env
chmod 600 ~/.config/protocol-info/.env
```

这个用户配置路径不在插件缓存目录内，插件更新不会覆盖它。不配置 `ROOTDATA_API_KEY` 时，管线仍然可用，只会跳过 RootData 证据。

安装后可以直接调用 slash command：

```text
/protocol-info:protocol-info --display-name "Pendle" --type fixed_rate
/protocol-info:protocol-info --display-name "Pendle" --type fixed_rate --i18n all
/protocol-info:protocol-info --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" --type fixed_rate \
  --batch --display-name "Morpho" --type simple_earn
```

也可以用自然语言触发内置 skill，例如：

- “调研 Pendle 的 protocol info，并翻译成中文和日文。”
- “批量抓 Morpho 和 Aave 的 earn 信息，不要翻译。”
- “给我做一份 Lido 的 protocol-info。” 如果类型不明确，skill 会先问一个短问题。
- “Crawl protocol info for Morpho and translate to all locales.”

Skill 位于 `skills/protocol-info-crawler/SKILL.md`，最终会派发到 `/protocol-info:protocol-info`。

## 作为独立 CLI 使用

克隆仓库后运行：

```bash
./run.sh --display-name "Pendle" --type fixed_rate
```

`run.sh` 只负责加载环境变量，然后委托给 `framework/cli.mjs`。环境文件查找顺序：

1. `<repo>/.env`
2. `~/.config/protocol-info/.env`

本地依赖：

| 工具 | 用途 |
| --- | --- |
| `claude` CLI | Headless Claude 调用 |
| `node` >= 18 | 管线运行时 |

## 常用命令

单协议：

```bash
./run.sh --display-name "f(x)Protocol" --type simple_earn
```

指定 slug、RootData ID 或调研提示：

```bash
./run.sh --display-name "Pendle" --type fixed_rate \
  --slug pendle \
  --rootdata-id 874 \
  --hints "Yield trading protocol with PT/YT markets"
```

批量运行：

```bash
./run.sh --parallel 4 \
  --batch --display-name "Pendle" --type fixed_rate \
  --batch --display-name "Morpho" --type simple_earn \
  --batch --display-name "Aave" --type simple_earn
```

i18n：

```bash
./run.sh --display-name "Pendle" --type fixed_rate --i18n all
./run.sh --display-name "Pendle" --type fixed_rate --i18n zh_CN,ja_JP,en_US
./run.sh --display-name "Pendle" --type fixed_rate --i18n none
```

Dry run：

```bash
./run.sh --dry-run --display-name "Pendle" --type fixed_rate
```

## CLI 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--display-name <name>` | 是 | 协议显示名称。 |
| `--type <type>` | 否，推荐填写 | `fixed_rate`、`simple_earn`、`staking` 之一。不填时 metadata subtask 会尝试推断。 |
| `--slug <slug>` | 否 | 业务 key。默认由 display name 生成。 |
| `--hints <text>` | 否 | 传给 Claude 的额外调研上下文。 |
| `--rootdata-id <int>` | 否 | RootData 项目 ID。不填时，如果设置了 `ROOTDATA_API_KEY`，fetcher 会按名称搜索。 |
| `--batch` | 否 | 结束当前 provider，开始下一个 provider。 |
| `--model <name>` | 否 | 覆盖 R1 和 R2 使用的模型。 |
| `--max-turns <n>` | 否 | 每次 Claude 调用的 turn 上限，会向下 clamp manifest 默认值。 |
| `--max-budget <usd>` | 否 | 单个 provider 的总 LLM 预算上限，由 orchestrator 分配给 R1、R2、i18n。 |
| `--parallel <n>` | 否 | 并发 provider 数量，默认 `1`。 |
| `--i18n <flag>` | 否 | `none`、`all`，或逗号分隔 locale，例如 `zh_CN,ja_JP`。为空时静默跳过。 |
| `--i18n-parallel <n>` | 否 | locale 翻译并发数，默认 `8`。 |
| `--i18n-model <name>` | 否 | 覆盖 i18n 模型。manifest 默认值为 `claude-haiku-4-5-20251001`。 |
| `--dry-run` | 否 | 打印解析后的 provider 后退出，并强制 `--parallel 1`。 |
| `--manifest <path>` | 否 | 高级用法：运行其他 consumer manifest。 |

## 输出结构

每个协议运行输出到：

```text
out/<slug>/<run-id>/
```

批量索引输出到：

```text
out/_runs/<run-id>/
```

常见文件：

| 文件 | 用途 |
| --- | --- |
| `record.json` | 通过 schema 校验的源语言 `EarnProtocolInfo` 记录。 |
| `record.full.json` | 内联 i18n 版本，仅在生成翻译时存在。 |
| `record.import.json` | Dashboard 导入信封：`{ version, exportedAt, data: [...] }`，已移除 `sources`。 |
| `findings.json` | 字段级证据，包含来源 URL 和 confidence。 |
| `gaps.json` | 未解决或弱证据字段，以及已尝试的搜索路径。 |
| `changes.json` | R2 对账改动及原因。 |
| `meta.json` | 运行状态、RootData 使用情况、预算计划、R1/R2 telemetry、i18n 状态。 |
| `summary.tsv` | 单协议 summary row。 |
| `_debug/` | 原始 envelope、stderr 日志、中间 evidence、i18n sidecar。 |

批量 summary：

```text
out/_runs/<run-id>/summary.tsv
```

## 管线

```text
R0 fetch
  RootData + DeFiLlama evidence
        |
        v
R1 fan-out
  metadata / team / funding / audits
        |
        v
Merge slices + evidence diff
        |
        v
R2 audit-first reconcile
  optional RootData search channel
        |
        v
Normalize + schema validate
        |
        v
Optional i18n
        |
        v
Post-process dashboard export
```

### R0 fetch

Fetcher 会在 Claude 合成前获取结构化证据。RootData 需要 `ROOTDATA_API_KEY`；DeFiLlama 不需要 key。可选 fetcher 缺失不会导致运行失败。

### R1 fan-out

四个独立 Claude subtask 针对 schema slice 并行运行：

- `metadata`
- `team`
- `funding`
- `audits`

每个 subtask 返回：

```json
{
  "slice": {},
  "findings": [],
  "gaps": [],
  "handoff_notes": []
}
```

### R2 reconcile

R2 使用 audit-first 策略合并 R1 slice 和证据：

- R1 高置信字段不会被无来源的 R2 改动覆盖。
- R2 可以在有来源证据时补充缺失字段。
- 搜索请求受限，并通过允许的 fetcher search channel 执行。
- 每个接受的改动都会写入 `changes.json`。

### Normalize And Validate

Consumer normalizer 会做决定性后处理，例如更新 `audits.lastScannedAt`。最终 `record.json` 必须通过 `consumers/protocol-info/schemas/full.json`。

### i18n And Export

如果设置了 `--i18n`，Haiku 会翻译 manifest 配置的字段：

- `description`
- `members[].memberPosition`
- `members[].oneLiner`

然后 post-processing 生成：

- `record.full.json`：内联预览
- `record.import.json`：dashboard 导入

## Schema 摘要

主 schema 位于 `consumers/protocol-info/schemas/full.json`。

顶层字段：

```json
{
  "slug": "pendle",
  "provider": "pendle",
  "displayName": "Pendle",
  "type": "fixed_rate",
  "description": "...",
  "tags": ["yield", "fixed-rate"],
  "establishment": 2021,
  "members": [],
  "providerWebsite": "https://...",
  "providerXLink": "https://...",
  "providerDiscordLink": null,
  "status": "draft",
  "fundingRounds": [],
  "audits": {
    "items": [],
    "lastScannedAt": "2026-04-27"
  },
  "sources": ["https://..."]
}
```

关键约束：

- `type`：`fixed_rate`、`simple_earn`、`staking`
- `status`：crawler 输出应为 `draft`
- `members`：至少 1 个成员
- `fundingRounds`：完整融资历史，最新轮次在前
- `audits.items[].date`：`YYYY-MM` 或 `YYYY-MM-DD`；裸年份无效
- URL 字段必须是绝对 URI；可空字段可为 `null`
- `sources` 是审计追踪字段，会从 `record.import.json` 中移除

## 支持的 Locale

| Code | 语言 |
| --- | --- |
| `bn` | 孟加拉语 |
| `de` | 德语 |
| `en_US` | 英语（美国） |
| `es` | 西班牙语 |
| `fr_FR` | 法语 |
| `hi_IN` | 印地语 |
| `id` | 印尼语 |
| `it_IT` | 意大利语 |
| `ja_JP` | 日语 |
| `ko_KR` | 韩语 |
| `pt` | 葡萄牙语 |
| `pt_BR` | 葡萄牙语（巴西） |
| `ru` | 俄语 |
| `th_TH` | 泰语 |
| `uk_UA` | 乌克兰语 |
| `vi` | 越南语 |
| `zh_CN` | 简体中文 |
| `zh_HK` | 繁体中文（香港） |
| `zh_TW` | 繁体中文（台湾） |

## 审核与导入

推荐审核流程：

1. 打开 `out/_runs/<run-id>/summary.tsv`。
2. 对每个 `OK` row，检查 `out/<slug>/<run-id>/record.json`。
3. 查看 `findings.json`，确认来源覆盖。
4. 查看 `gaps.json`，确认缺失或弱证据字段。
5. 如果 R2 修改过 R1 输出，查看 `changes.json`。
6. 审核通过后导入 `record.import.json`。

导入示例：

```bash
curl -X POST "$DASHBOARD/api/earn-protocol-info/import" \
  -H "Content-Type: application/json" \
  -d @out/<slug>/<run-id>/record.import.json
```

即使没有 i18n，`record.import.json` 也会包含一条 dashboard locale 为 `en` 的源语言记录。

## 故障排查

### `claude CLI not found`

安装 Claude Code，并确保 `claude` 在 `PATH` 中，或设置 `CLAUDE_BIN`：

```bash
CLAUDE_BIN=/path/to/claude ./run.sh --display-name "Pendle" --type fixed_rate
```

### RootData disabled

在 `<repo>/.env` 或 `~/.config/protocol-info/.env` 中设置 `ROOTDATA_API_KEY`。不设置时，RootData fetch 和 search channel 会被跳过。

### `SCHEMA_FAIL`

打开协议输出目录，检查：

- `record.json`
- `gaps.json`
- `changes.json`
- `_debug/schema.stderr.log`（如果存在）

常见原因包括 URL 无效、缺少必填成员、日期不完整、audit date 使用裸年份。

### i18n 部分成功

Summary 中可能出现 `3/19` 这类结果。检查：

```text
out/<slug>/<run-id>/_debug/i18n/
```

成功生成的 locale sidecar 仍会被 post-processing 使用。

### 输出路径变化

当前结构是 protocol-first：

```text
out/<slug>/<run-id>/
out/_runs/<run-id>/summary.tsv
```

旧文档或旧产物中的 `out/<run-id>/<slug>/` 路径已经过期。

## 开发

运行全部本地检查：

```bash
node scripts/check-all.mjs
```

验证 Claude Code 插件：

```bash
claude plugin validate .
```

框架按 consumer 扩展。新增 consumer 时，需要提供 manifest、完整 schema、slice schemas、prompts，以及可选 fetchers、normalizers、post-processing 模块。共享 framework 负责调度、预算分配、证据合并、校验、i18n 和 summary。
