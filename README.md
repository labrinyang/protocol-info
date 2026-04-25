# protocol-info

Claude Code plugin + standalone CLI — 通过 `claude -p` 无头模式抓取 `EarnProtocolInfo` JSON
记录。配置 RootData API 密钥后管线会运行第二轮对账（Round 2），使用结构化 API 数据提升准确性。
可选用 Haiku 翻译成 19 种语言。输出经人工审核后通过 `earn-protocol-info.controller.ts` CRUD
端点导入 dashboard MongoDB。

## 作为 Claude Code plugin 安装(推荐)

```
/plugin marketplace add labrinyang/protocol-info
/plugin install protocol-info@labrinyang
```

**可选:启用 Round 2 对账**(需要 RootData API key):

```bash
mkdir -p ~/.config/protocol-info
echo "ROOTDATA_API_KEY=sk-..." > ~/.config/protocol-info/.env
chmod 600 ~/.config/protocol-info/.env
```

这个路径在 plugin 更新时不会被覆盖。不配置时管线单轮运行,仍然可用。

安装后你有两种调用方式:

### 方式 A:显式 slash command

```
/protocol-info --display-name "Pendle" --type fixed_rate
/protocol-info --display-name "Pendle" --type fixed_rate --i18n all
/protocol-info --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" --type fixed_rate \
  --batch --display-name "Morpho" --type simple_earn
```

### 方式 B:自然语言(skill 自动触发)

直接在对话里说出意图,Claude 会识别并自动派发 `/protocol-info`:

- "调研 Pendle 的项目概述,翻成中日英"
- "批量爬 Morpho 和 Aave 的 earn 信息,不用翻译"
- "给我做一份 Lido 的 protocol-info"(会先问类型)
- "crawl protocol info for Morpho, translate to all 19 locales"

skill 定义在 `skills/protocol-info-crawler/SKILL.md`,触发词覆盖调研/抓取/批量/翻译等意图。类型不明时会问一句再跑。

## 作为独立 CLI 使用

克隆仓库后直接跑 `./run.sh`(plugin 内部也是调它)。下文的所有说明对两种模式都适用。

## 目录结构

```
protocol-info/
├── .claude-plugin/
│   ├── plugin.json                        # plugin 清单
│   └── marketplace.json                   # 公开市场条目(单 plugin 仓库)
├── commands/
│   └── protocol-info.md                   # /protocol-info slash command
├── skills/
│   └── protocol-info-crawler/
│       └── SKILL.md                       # 自然语言触发 → 派发 /protocol-info
├── run.sh                                 # 主驱动(Round 1 + Round 2 + i18n)
├── preprocess-rootdata.mjs                # RootData API 客户端 + 成员评分
├── extract-json.mjs                       # 从文本中提取 JSON
├── validate.mjs                           # 零依赖 schema 校验器
├── .env.example                           # API 密钥模板
├── LICENSE                                # MIT
├── prompts/
│   ├── system.md                          # Round 1 系统提示词
│   ├── user.md.tmpl                       # Round 1 provider 模板
│   ├── reconcile.md.tmpl                  # Round 2 对账模板
│   ├── i18n.system.md                     # i18n 翻译系统提示
│   └── i18n.user.md.tmpl                  # i18n 翻译模板
├── schema/
│   ├── earn-protocol-info.schema.json     # 主记录 JSON Schema
│   └── i18n.schema.json                   # i18n 单 locale JSON Schema
└── out/
    └── <YYYYMMDDTHHMMSSZ>/
        ├── summary.tsv                    # 汇总表(含 i18n 列)
        └── <slug>/
            ├── record.json                # ⭐ 源语言主记录(crawler invariant)
            ├── record.full.json           # ⭐ 内联版(record + .i18n) 仅翻译后生成
            ├── record.import.json         # ⭐ dashboard 导入格式 ({version,data:[]} per-locale)
            ├── meta.json                  # 运行元数据(cost/turns/overrides/i18n)
            └── _debug/                    # 审计 / 排障
                ├── r1.envelope.json
                ├── r1.stderr.log
                ├── r2.envelope.json       # Round 2 执行时
                ├── r2.stderr.log
                ├── rootdata.json          # API 启用时
                ├── rootdata.stderr.log
                ├── parse.stderr.log       # 仅 PARSE_FAIL 时
                ├── schema.stderr.log      # 仅 SCHEMA_FAIL 时
                └── i18n/                  # 翻译启用时
                    ├── <locale>.json
                    ├── <locale>.envelope.json
                    └── failures.log       # 仅有失败时
```

## 前置依赖

| 工具                       | 用途                                     |
| -------------------------- | ---------------------------------------- |
| `claude` CLI (Claude Code) | 无头 LLM 调用                            |
| `jq`                       | `run.sh` 中的 JSON 模板渲染              |
| `node` (≥ 18)              | `validate.mjs`, `preprocess-rootdata.mjs` |

## 初始设置

```bash
# 1. 配置 RootData API 密钥（可选，启用 Round 2 对账）
cp .env.example .env
# 编辑 .env，填入 ROOTDATA_API_KEY

# 2. 运行
./run.sh --display-name "Pendle" --type fixed_rate
```

未配置 `.env` 或 `ROOTDATA_API_KEY` 时，管线以单轮模式运行。

## 用法

```bash
# 单个 provider（最少需要 --display-name 和 --type）
./run.sh --display-name "f(x)Protocol" --type simple_earn

# 可选参数：指定 slug、hints、rootdata-id
./run.sh --display-name "Pendle" --type fixed_rate \
         --slug pendle --hints "Yield trading protocol" --rootdata-id 874

# 批量模式（用 --batch 分隔多组 provider）
./run.sh \
  --batch --display-name "Pendle" --type fixed_rate --slug pendle \
  --batch --display-name "Morpho" --type simple_earn --slug morpho

# 通用选项
./run.sh --model sonnet --display-name "Pendle" --type fixed_rate
./run.sh --max-turns 40 --display-name "Pendle" --type fixed_rate
./run.sh --max-budget 2.00 --display-name "Pendle" --type fixed_rate
./run.sh --dry-run --display-name "Pendle" --type fixed_rate

# 并发批跑（顺序执行见默认 --parallel 1）
./run.sh --parallel 4 \
  --batch --display-name "Pendle" --type fixed_rate \
  --batch --display-name "Morpho" --type simple_earn \
  --batch --display-name "Aave"   --type simple_earn

# i18n 翻译（跑完主管线后触发 Haiku 翻 status=OK 的记录）
./run.sh --i18n all --display-name "Pendle" --type fixed_rate           # 全 19 种语言
./run.sh --i18n zh_CN,ja_JP,en_US --display-name "Pendle" --type fixed_rate  # 指定
./run.sh --i18n none --display-name "Pendle" --type fixed_rate          # 显式跳过(CI)
./run.sh --display-name "Pendle" --type fixed_rate                      # tty 下交互问
```

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--display-name` | 是 | Provider 显示名称 |
| `--type` | 是 | 类型：`fixed_rate` / `simple_earn` / `staking` |
| `--slug` | 否 | 自定义 slug，不传则从 display-name 自动生成 |
| `--hints` | 否 | 给 Claude 的额外上下文提示 |
| `--rootdata-id` | 否 | RootData 项目 ID，不传则自动通过 API 按名称搜索 |
| `--batch` | 否 | 批量分隔符，每个 `--batch` 开始一组新的 provider 参数 |
| `--model` | 否 | 指定 Claude 模型 |
| `--max-turns` | 否 | 最大轮数（默认 40） |
| `--max-budget` | 否 | 每个 provider 的 API 预算上限（默认 $2.00） |
| `--parallel` | 否 | 同时并发的 provider 数（默认 1；`>1` 时 worker 输出缓冲到日志，结束后按调度顺序汇总打印） |
| `--i18n` | 否 | `all` / `none` / 逗号分隔 locale(如 `zh_CN,ja_JP`)；不传则 tty 下交互问,非 tty 下自动跳过 |
| `--i18n-parallel` | 否 | i18n 翻译并发数（默认 8；Haiku 快且便宜） |
| `--i18n-model` | 否 | i18n 使用的模型（默认 `claude-haiku-4-5-20251001`） |
| `--dry-run` | 否 | 只打印 prompt，不调用 Claude（会强制 `--parallel 1`，i18n 也跳过） |

## 管线概览

```
Round 1（Claude 网页抓取） ──┐
                             ├── 等待 ── Round 2（对账） ── 校验 ──┐
RootData API（并行）       ──┘                                    │
                                                                   ▼
                                             对 status=OK 的 slug 跑 i18n
                                             (Haiku, 并发, 每 locale 一次)
                                                                   │
                                                                   ▼
                                             record.full.json + meta.i18n
```

- **Round 1**: Claude 搜索网页，产出 protocol-info JSON(schema 强制)。
- **RootData API**（并行）: 获取结构化数据——团队、投资方、链接、成立年份——并评分候选成员。
- **Round 2**: 恢复同一 Claude 会话，注入 API 证据,交叉验证并改进输出。
- **后处理**: 应用已校验的 URL 覆盖，标准化日期,schema 校验。
- **i18n**(可选): 主管线结束后,用 Haiku 把 `description` + `members[].{memberPosition, oneLiner}` 翻译到选定 locale,生成 `record.full.json`。
- 如果 API 不可用或无匹配结果，管线自动回退到 Round 1 输出。

## 可选 i18n locale 清单

| Code | 语言 |
|---|---|
| `bn` | 孟加拉语 |
| `de` | 德语 |
| `en_US` | 英语(美国) |
| `es` | 西班牙语 |
| `fr_FR` | 法语 |
| `hi_IN` | 印地语 |
| `id` | 印尼语 |
| `it_IT` | 意大利语 |
| `ja_JP` | 日语 |
| `ko_KR` | 韩语 |
| `pt` | 葡萄牙语 |
| `pt_BR` | 葡萄牙语(巴西) |
| `ru` | 俄语 |
| `th_TH` | 泰语 |
| `uk_UA` | 乌克兰语 |
| `vi` | 越南语 |
| `zh_CN` | 简体中文 |
| `zh_HK` | 繁体中文(香港) |
| `zh_TW` | 繁体中文(台湾) |

## 审核与导入

1. 检查 `out/<run>/summary.tsv`(含 i18n 成功率列)。
2. 对每个 `<slug>/record.json`: 验证成员、融资、审计信息。
3. 导入 dashboard 直接用 **`record.import.json`** — 已经是 dashboard 期望的 `{version, exportedAt, data:[...]}` 信封格式,每个 locale 一条记录,`sources` 已 strip:
   ```bash
   curl -X POST $DASHBOARD/api/earn-protocol-info/import \
     -H "Content-Type: application/json" \
     -d @out/<run>/<slug>/record.import.json
   ```
   即使没翻译,`record.import.json` 也包含 1 条 `locale: "en"` 的源语言记录。
4. **`record.json`** 仍然保留(crawler invariant 严格 schema 通过的源语言记录,人工审核用)。
5. **`record.full.json`** 仍然保留(嵌套 i18n 的 inline 版本,前端预览方便)。

## Schema 约定

- **`slug` == `provider`**（每个 provider 一条记录）。
- **`status`** 始终为 `"draft"`，审核后通过 dashboard 提升状态。
- **`provider`** 字段不再在脚本层面做 enum 硬编码校验，格式要求为 `^[a-z][a-z0-9-]*$`。
