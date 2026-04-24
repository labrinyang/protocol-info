# protocol-info crawler

通过 `claude -p` 无头模式抓取 `EarnProtocolInfo` JSON 记录。配置 RootData API 密钥后，
管线会运行第二轮对账（Round 2），使用结构化 API 数据提升准确性。输出经人工审核后通过
`earn-protocol-info.controller.ts` CRUD 端点导入 dashboard MongoDB。

## 目录结构

```
script/protocol-info/
├── run.sh                                 # 主驱动脚本（Round 1 + 可选 Round 2 + 可选翻译）
├── translate.mjs                          # i18n 翻译（并发 claude -p haiku）
├── preprocess-rootdata.mjs                # RootData API 客户端 + 成员评分
├── extract-json.mjs                       # 从文本中提取 JSON
├── validate.mjs                           # 零依赖 schema 校验器
├── .env.example                           # API 密钥模板
├── prompts/
│   ├── system.md                          # Round 1 系统提示词
│   ├── user.md.tmpl                       # Round 1 每个 provider 的模板
│   ├── reconcile.md.tmpl                  # Round 2 对账模板
│   └── translate-system.md                # 翻译系统提示词模板
├── schema/
│   └── earn-protocol-info.schema.json     # JSON Schema（含可选 locale 字段）
├── test/                                  # 单元测试 + 集成测试
│   ├── run-tests.sh                       # 测试运行器
│   └── test-*.mjs                         # 各项测试用例
└── out/
    └── <YYYYMMDDTHHMMSSZ>/
        ├── <slug>.json                    # 英文源记录（含 locale:"en"）
        ├── <slug>.<locale>.json           # 翻译后的记录（如 slug.zh-cn.json）
        └── .logs/                         # 调试日志（不需要导入）
            ├── summary.tsv
            ├── <slug>.raw.json
            ├── <slug>.r2.raw.json
            ├── <slug>.rootdata-packet.json
            ├── <slug>.sidecar.json
            ├── <slug>.stderr.log
            └── <slug>.translate-summary.tsv
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
| `--dry-run` | 否 | 只打印 prompt，不调用 Claude |
| `--translate` | 否 | 启用 i18n 翻译（schema 校验通过后，用 Haiku 翻译为 20 个 locale） |
| `--translate-concurrency` | 否 | 翻译并发数（默认 6） |
| `--translate-locales` | 否 | 逗号分隔的 locale 子集（默认全部 20 个） |

## 管线概览

```
Round 1（Claude 网页抓取） ──┐
                             ├── 等待 ── Round 2（对账） ── 后处理 ── 校验 ── [翻译]
RootData API（并行）       ──┘
```

- **Round 1**: Claude 搜索网页，产出 protocol-info JSON。
- **RootData API**（并行）: 获取结构化数据——团队、投资方、链接、成立年份——并评分候选成员。
- **Round 2**: 恢复同一 Claude 会话，注入 API 证据。Claude 交叉验证并改进输出。
- **后处理**: 应用已校验的 URL 覆盖，标准化日期。
- **翻译**（`--translate`）: 将 `description`、`tags`、`memberPosition`、`oneLiner`、`fundingRounds[].round` 翻译为 20 个 locale。
- 如果 API 不可用或无匹配结果，管线自动回退到 Round 1 输出。

## 翻译已有 out 文件

无需重跑 Round 1/2，可直接对已有 JSON 文件翻译：

```bash
# 单个文件
node translate.mjs out/<ts>/pendle.json

# 指定 locale 子集
node translate.mjs out/<ts>/pendle.json --locales zh-cn,ja-jp,ko-kr

# 批量翻译所有已有文件
for f in out/*/[a-z]*.json; do
  node translate.mjs "$f" --concurrency 3
done
```

## 测试

```bash
./test/run-tests.sh                        # 单元测试（免费、快速）
INTEGRATION=1 ./test/run-tests.sh          # 含真实 Haiku 调用（~$0.01）
```

## 审核与导入

1. 检查 `out/<run>/.logs/summary.tsv`。
2. 对每个 `<slug>.json`: 验证成员、融资、审计信息。
3. `out/<run>/` 下所有 `.json` 文件即为可导入数据（日志在 `.logs/` 子目录）。
4. POST 到 `dashboard/v1/earn/protocol-info/import` 端点。

## Schema 约定

- **`slug` == `provider`**（每个 provider 一条记录）。
- **`status`** 始终为 `"draft"`，审核后通过 dashboard 提升状态。
- **`provider`** 字段不再在脚本层面做 enum 硬编码校验，格式要求为 `^[a-z][a-z0-9-]*$`。
