# protocol-info

[English](README.md) | 简体中文

`protocol-info` 是一个 Claude Code 插件，也可以作为独立 CLI 使用。它用于调研 DeFi earn/yield/staking 协议，并生成通过 JSON Schema 校验的 `EarnProtocolInfo` JSON。

它会以 headless 模式调用 Claude，从 RootData、DeFiLlama 等可选 fetcher 获取结构化证据，按字段合并和对账，校验最终记录，把 protocol/team member/auditor logo 下载到稳定输出目录，并可选择用 Claude Haiku 或 OpenAI-compatible 网关翻译 19 个 locale 的字段。

输出应先人工审核，再通过 dashboard 的 `earn-protocol-info` import endpoint 导入。

默认情况下，生成产物会写入调用命令时当前目录下的 `out/`。输出根目录不绑定
plugin cache，因此更新插件不会改变历史输出所在位置。

当前版本：`2.4.0`。

## 2.4 重点更新

- 实时 out browser 成为主要审核 UI。它直接读取 `out/`，因此
  `out/<slug>/record.json` 更新后无需重建静态 HTML。
- RootData 支持多个 API key，并发批量运行时会随机起点轮换，并在限流/失败时 fallback。
- Provider、成员、审计机构 logo 会下载到可直接上传的目录，并改写为 OneKey CDN URL。
- R2 前会抓取 audit report URL；PDF/HTML 文本可通过
  `AUDIT_REPORTS_LLM_PROVIDER=openai` 交给 OpenAI-compatible LLM 做结构化阅读。
- Claude 调用有 wall-clock watchdog；R1 会把实时 subtask telemetry 写到
  `out/<slug>/_debug/r1/r1-status.json`。

## 快速开始

```bash
# 抓取单个协议到 ./out/<slug>/
./run.sh --display-name "Pendle"

# 用实时浏览器审核当前 out/ 数据。
./run.sh browse

# RootData 多 key + i18n 批量抓取。
ROOTDATA_API_KEYS=sk-a,sk-b \
I18N_PROVIDER=openai \
./run.sh --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" \
  --batch --display-name "Morpho"
```

## 适用场景

当你需要可重复的协议调研管线时，使用本项目：

- 协议简介、标签、官网、X、Discord 链接
- 成立年份
- 公开团队成员、职位、社媒链接、短 bio
- 融资轮次、投资方、金额、估值、日期
- 审计报告、审计方、范围、报告链接、扫描时间
- Provider、团队成员、审计机构 logo URL 改写为稳定的 OneKey CDN 路径
- 字段级来源、未解决 gap、R2 改动审计
- 可选的 dashboard 多语言导入输出

它不是全自动发布系统。Crawler 负责产出可审核记录；团队、融资、审计信息仍应由人工复核后再进入生产。

## 作为 Claude Code 插件安装

推荐安装方式：

```text
/plugin marketplace add labrinyang/protocol-info
/plugin install protocol-info@labrinyang
```

可选运行时配置可以放在 `~/.config/protocol-info/.env` 或 `<repo>/.env`。
shell 里已经导出的变量优先；`.env` 只补齐缺失变量。

RootData key 解析顺序：

1. `--rootdata-key <key>` CLI 参数（一次性，不写入磁盘；可传逗号/换行分隔的多个 key）
2. 调用 shell 中导出的 `ROOTDATA_API_KEYS` 或 `ROOTDATA_API_KEY`
3. `~/.config/protocol-info/.env`（推荐：插件用户使用，更新插件时不会被覆盖）
4. `<repo>/.env`（仅独立 CLI；安装为插件时该路径在只读缓存里，会被忽略）

把 key 持久化到插件可读的位置：

```bash
mkdir -p ~/.config/protocol-info
echo "ROOTDATA_API_KEY=sk-..." > ~/.config/protocol-info/.env
chmod 600 ~/.config/protocol-info/.env
```

并发批量跑时可以配置多个 key。每次 RootData API 调用会从随机 key 开始，
遇到限流或失败会自动 fallback 到池里的其他 key：

```bash
ROOTDATA_API_KEYS=sk-a,sk-b,sk-c
# 或：
ROOTDATA_API_KEY_1=sk-a
ROOTDATA_API_KEY_2=sk-b
```

或者临时使用一次：

```bash
/protocol-info:protocol-info --rootdata-key sk-a,sk-b --display-name "Pendle"
```

启动横幅会标明 key 数量和来源（`shell-env`、`--rootdata-key`，或解析到的 `.env` 路径）。不配置 RootData key 时，管线仍然可用，只会跳过 RootData 证据。

付费 Unavatar key 用于成员 / 审计机构头像下载和 rehost：

```bash
UNAVATAR_API_KEY=sk-...
```

`UNAVATAR_API_KEY` 使用与 RootData 相同的 shell / `~/.config/protocol-info/.env` /
`<repo>/.env` 优先级。也可以用 `--unavatar-key <key>` 临时传入一次。不配置时仍可匿名尝试 Unavatar，但可能触发公共限流。

可选的 OpenAI-compatible LLM 网关配置：

```bash
I18N_PROVIDER=openai
OPENAI_BASE_URL=https://llm.example.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
# 可选：配置后外部路由可计费并参与 --max-budget
OPENAI_INPUT_COST_PER_1M=1.25
OPENAI_OUTPUT_COST_PER_1M=10
```

OpenAI-compatible 配置使用和 RootData 一样的优先级：

1. 一次性 CLI 参数：`--openai-api-key`、`--openai-base-url`、`--openai-model`、`--openai-input-cost-per-1m`、`--openai-output-cost-per-1m`
2. shell 中已导出的变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、pricing vars
3. `~/.config/protocol-info/.env`（推荐：插件用户使用）
4. `<repo>/.env`（仅独立 CLI）

一次性运行示例：

```bash
./run.sh --openai-api-key sk-... \
  --openai-base-url https://llm.example.com/v1 \
  --openai-model gpt-5.5 \
  --i18n all \
  --display-name "Pendle"
```

`i18n` 是最适合外部 LLM 的阶段。R2 和字段级 analyze 也可以通过
`R2_LLM_PROVIDER=openai` 或 `ANALYZE_LLM_PROVIDER=openai` 显式启用；它们只使用现有 evidence 和已批准 search channel，不具备 Claude WebFetch/WebSearch。R2 直接使用 `R2_LLM_PROVIDER=openai` 时会切到 evidence-only reconcile prompt。`--r2-routing external_first` 或 `R2_ROUTING=external_first` 会先跑外部 evidence-only R2，并在 deterministic gate 拒绝时 fail closed；`--r2-routing external_first_with_claude_fallback` 或 `R2_ROUTING=external_first_with_claude_fallback` 会在 gate 拒绝时回退到 Claude web reconcile。`AUDIT_REPORTS_LLM_PROVIDER=openai` 会在 R2 前对已 fetch 的 audit report 文本做外部结构化阅读；`REFRESH_AUDITS_LLM_PROVIDER=openai` 也允许，因为 audit report 文本会先被确定性抽取，并使用 evidence-only audit refresh prompt。R1 和其他 refresh subtask 默认由策略锁定为 Claude，除非 manifest 明确放开。OpenAI-compatible 网关在未配置价格时记录 `cost_usd: null`；配置价格后可参与 `--max-budget` 核算。
启动横幅会报告 OpenAI-compatible key/base/model/pricing 的来源，但不会打印 API key。

长时间运行的 Claude 调用内置 wall-clock watchdog，避免某个 web research 子任务停住后长期阻塞批量队列。默认值：

```bash
# 默认 30 分钟；只有明确需要禁用 watchdog 时才设为 0。
CLAUDE_TIMEOUT_MS=1800000
# 支持按 stage/provider 覆盖。
R1_CLAUDE_TIMEOUT_MS=1800000
R2_CLAUDE_TIMEOUT_MS=2400000
# R1 会写 out/<slug>/_debug/r1/r1-status.json，并按该间隔输出进度心跳。
R1_HEARTBEAT_MS=60000
```

安装后可以直接调用 slash command：

```text
/protocol-info:protocol-info --display-name "Pendle"
/protocol-info:protocol-info --display-name "Pendle" --i18n all
/protocol-info:protocol-info --parallel 4 --i18n zh_CN,ja_JP \
  --batch --display-name "Pendle" \
  --batch --display-name "Morpho"
```

也可以用自然语言触发内置 skill，例如：

- “调研 Pendle 的 protocol info，并翻译成中文和日文。”
- “批量抓 Morpho 和 Aave 的 earn 信息，不要翻译。”
- “给我做一份 Lido 的 protocol-info。”
- “Crawl protocol info for Morpho and translate to all locales.”
- “把已有 Pendle 记录补翻成日语。”
- “核实 Pendle 的 fundingRounds 并应用更新。”

Skill 位于 `skills/protocol-info-crawler/SKILL.md`，最终会派发到 `/protocol-info:protocol-info`。

## 作为独立 CLI 使用

克隆仓库后运行：

```bash
./run.sh --display-name "Pendle"
```

`run.sh` 只负责加载环境变量，然后委托给 `framework/cli.mjs`。它按以下顺序填充缺失的环境变量：

1. 调用 shell 中已经导出的环境变量
2. `~/.config/protocol-info/.env`
3. `<repo>/.env`

本地依赖：

| 工具 | 用途 |
| --- | --- |
| `claude` CLI | Headless Claude 调用 |
| `node` >= 18 | 管线运行时 |

## 常用命令

单协议：

```bash
./run.sh --display-name "f(x)Protocol"
```

指定 slug、RootData ID 或调研提示：

```bash
./run.sh --display-name "Pendle" \
  --slug pendle \
  --rootdata-id 874 \
  --hints "Yield trading protocol with PT/YT markets"
```

批量运行：

```bash
./run.sh --parallel 4 \
  --batch --display-name "Pendle" \
  --batch --display-name "Morpho" \
  --batch --display-name "Aave"
```

i18n：

```bash
./run.sh --display-name "Pendle" --i18n all
./run.sh --display-name "Pendle" --i18n zh_CN,ja_JP,en_US
./run.sh --display-name "Pendle" --i18n none
```

OpenAI-compatible no-web 路由：

```bash
I18N_PROVIDER=openai ./run.sh --display-name "Pendle" --i18n all
R2_ROUTING=external_first_with_claude_fallback ./run.sh --display-name "Pendle"
R2_LLM_PROVIDER=openai ./run.sh --display-name "Pendle"
```

基于已有 `out/<slug>/` 的工作流命令：

```bash
./run.sh get pendle description
./run.sh set pendle description '"更新后的源语言描述"'
./run.sh analyze pendle fundingRounds --query "verify latest funding rounds"
./run.sh analyze pendle fundingRounds --query "verify latest funding rounds" --llm-provider openai --apply
./run.sh i18n pendle --locales zh_CN,ja_JP
./run.sh refresh pendle audits --llm-provider openai
./run.sh history pendle
./run.sh diff pendle
./run.sh restore pendle <sha>
```

写入类命令都会先运行 deterministic normalizer，再校验完整记录；源字段变化时
会清理 stale i18n 产物，随后运行 post-processing 以保持
`record.import.json` 同步，在 `out/` 的本地 git 仓库里生成一个 scoped commit，
实时浏览器会直接读取更新后的 `out/` 树。不带 `--apply` 的 `analyze` 只输出提案，不写文件。
工作流命令可以使用一次性 `--openai-*` 配置参数；`analyze` 和 `refresh`
也接受 `--llm-provider openai`。外部 refresh 默认只允许 `audits`；其他
refresh subtask 继续使用 Claude，除非 manifest 显式放开。

Dry run：

```bash
./run.sh --dry-run --display-name "Pendle"
```

## CLI 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--display-name <name>` | 是 | 协议显示名称。 |
| `--slug <slug>` | 否 | 业务 key。默认由 display name 生成。 |
| `--hints <text>` | 否 | 传给 Claude 的额外调研上下文。 |
| `--rootdata-id <int>` | 否 | RootData 项目 ID。不填时，如果设置了 `ROOTDATA_API_KEY`，fetcher 会按名称搜索。 |
| `--batch` | 否 | 结束当前 provider，开始下一个 provider。 |
| `--model <name>` | 否 | 覆盖 R1 和 R2 使用的模型。manifest 默认值为 `claude-sonnet-4-6`。 |
| `--rootdata-key <key>` | 否 | 本次运行的 RootData API key，优先于 shell env 和 `.env` 文件，不会写入磁盘。 |
| `--unavatar-key <key>` | 否 | 本次运行的付费 Unavatar API key，优先于 shell env 和 `.env` 文件，不会写入磁盘。 |
| `--openai-api-key <key>` | 否 | 本次运行的 OpenAI-compatible API key，优先于 shell env 和 `.env` 文件，不会写入磁盘。 |
| `--openai-base-url <url>` | 否 | 本次运行的 OpenAI-compatible base URL。 |
| `--openai-model <name>` | 否 | OpenAI-compatible i18n/R2/analyze/refresh 路由使用的模型。 |
| `--openai-input-cost-per-1m <usd>` | 否 | 外部输入 token 单价，按 1M tokens 计，用于 cost 记录和 `--max-budget`。 |
| `--openai-output-cost-per-1m <usd>` | 否 | 外部输出 token 单价，按 1M tokens 计，用于 cost 记录和 `--max-budget`。 |
| `--max-turns <n>` | 否 | 每次 Claude 调用的 turn 上限，会向下 clamp manifest 默认值。 |
| `--max-budget <usd>` | 否 | 单个 provider 的总 LLM 预算上限，由 orchestrator 分配给 R1、R2、i18n。 |
| `--r2-routing <mode>` | 否 | R2 路由。默认 `single_provider`；`external_first` 会先跑 OpenAI-compatible evidence reconcile 并在 gate 拒绝时 fail closed；`external_first_with_claude_fallback` 会按需回退 Claude web reconcile。 |
| `--parallel <n>` | 否 | 并发 provider 数量，默认 `1`。 |
| `--i18n <flag>` | 否 | `none`、`all`，或逗号分隔 locale，例如 `zh_CN,ja_JP`。为空时静默跳过。 |
| `--i18n-parallel <n>` | 否 | locale 翻译并发数，默认 `8`。 |
| `--i18n-model <name>` | 否 | 覆盖 i18n 模型。manifest 默认值为 `claude-haiku-4-5-20251001`。 |
| `--dry-run` | 否 | 打印解析后的 provider 后退出，并强制 `--parallel 1`。 |
| `--force-overwrite` | 否 | 覆盖存在未提交改动的协议目录。不加时，v2 会拒绝覆盖手动修改。 |
| `--manifest <path>` | 否 | 高级用法：运行其他 consumer manifest。 |

`record.type` 不作为 CLI 输入字段，由 metadata subtask 根据证据推断。

## 工作流命令

这些命令作用于已有 crawl 生成的 canonical `out/<slug>/record.json`。它们不会为同一个协议创建第二份展示版本；历史、diff 和回滚都由 `out/` 内部的 git 仓库负责。

| 命令 | 写入？ | 用途 |
| --- | --- | --- |
| `get <slug> <jsonpath>` | 否 | 以 JSON 打印一个字段值。 |
| `set <slug> <jsonpath> <json>` | 是 | 手动替换一个字段，校验、post-process、commit。 |
| `analyze <slug> <jsonpath> --query <text>` | 否 | 调研一个字段，输出带证据的提案。 |
| `analyze <slug> <jsonpath> --query <text> --apply` | 是 | 把提案应用到同一个路径，校验、post-process、commit。 |
| `i18n <slug> [--locales LIST]` | 是 | 基于当前记录重新生成翻译 sidecar 和导出文件。 |
| `refresh <slug> <metadata|team|funding|audits>` | 是 | 重跑一个大的 R1 subtask，并通过 audit-first guard 合并。 |
| `history <slug> [--limit N]` | 否 | 查看单个协议的本地 git 历史。 |
| `diff <slug> [from] [to]` | 否 | 查看单个协议的 unified diff。不传 ref 时，比较该 slug 最新两次提交。 |
| `restore <slug> <sha>` | 是 | 恢复到过去的有效版本，post-process 后 commit。 |

## 输出结构

每个协议的 canonical 产物输出到：

```text
out/<slug>/
```

`out/` 是一个本地 git 仓库。每次成功抓取会为变更的协议目录生成一个 commit，批次 run id 写在 `Run-Id:` git trailer 中。批量 scratch 文件输出到：

```text
out/.runs/<run-id>/
```

用实时 out browser 审核输出：

```bash
./run.sh browse
# 或：
node framework/out-browser.mjs --out ./out --port 8765
```

实时 server 每次 API 请求都会读取当前 `out/` 树，页面会自动轮询；
`out/<slug>/record.json` 更新后，浏览器里的数据会自动刷新，不需要重建 HTML。
它可以筛选协议、查看产物、检查协议级改动、确认 logo 资产覆盖、复制工作流命令，或为当前可见记录复制一份合并后的 import JSON。列表和详情里的成员/融资/审计数量直接从当前 `record.json` 计算，即使单个 slug 缺少 `summary.tsv` 也不会显示成空。JSON 产物支持 shape/key chip、语法高亮、raw copy、minified copy 和直接打开文件；diff 会按行着色并支持复制。详情区有四个模式：

- `Artifacts`：预览/复制 `record.json`、`record.import.json`、`record.full.json`、findings、gaps、changes、meta 等文件，并提供 JSON 检查控件。
- `Changes`：查看该 slug 的本地 git history、最新 diff 统计和彩色 unified diff。
- `Assets`：检查 provider、member、audit logo 资产，以及本地上传目录中是否已有对应文件。
- `Commands`：复制当前协议常用的 `get`、`set`、`analyze`、`i18n`、`refresh`、`history`、`diff`、`restore` 命令。

它只提供审核用的关键产物；Claude/debug 原始日志仍保留在 `_debug/`。

![实时 out browser 本地审核工作台：Artifacts、Changes、Assets、Commands 和 run filter](docs/images/out-browser.png)

常见文件：

| 文件 | 用途 |
| --- | --- |
| `record.json` | 通过 schema 校验的源语言 `EarnProtocolInfo` 记录。用于审核/schema audit，不是 dashboard 导入信封。 |
| `record.full.json` | 内联 i18n 版本，仅在生成翻译时存在。 |
| `record.import.json` | Dashboard 导入信封：`{ version, exportedAt, data: [...] }`。导入时使用这个文件，已移除 `sources`。 |
| `findings.json` | 字段级证据，包含来源 URL 和 confidence。 |
| `gaps.json` | 未解决或弱证据字段，以及已尝试的搜索路径。 |
| `changes.json` | R2 对账改动及原因。 |
| `meta.json` | 运行状态、RootData 使用情况、预算计划、R1/R2 telemetry、i18n 状态。 |
| `summary.tsv` | 供本地管理页使用的单协议生成 summary row。Gitignored。 |
| `_debug/` | 原始 envelope、stderr 日志、中间 evidence、i18n sidecar、实时 R1 状态。 |
| `_debug/r1/r1-status.json` | 实时 R1 调度状态，包含 queued/running/ok/failed 计数、subtask pid、elapsed time、timeout、error kind。 |
| `../protocol-logo/` | `providerLogoUrl` 引用的 protocol/provider logo。上传到 `/static/logo/protocol-logo/`。 |
| `../protocol-member-logo/` | `members[].avatarUrl` 引用的团队成员 logo。上传到 `/static/logo/protocol-member-logo/`。 |
| `../audit-logo/` | `audits.items[].auditorLogoUrl` 引用的审计机构 logo。上传到 `/static/logo/audit-logo/`。 |

批量 summary：

```text
out/.runs/<run-id>/summary.tsv
```

### 从 1.x 升级

v2.0 把输出结构从 `out/<runId>/<slug>/` 改为 `out/<slug>/`，并且 `out/` 现在是一个本地 git 仓库（`out/.git/`）。每次成功抓取对应一个 commit；批量元数据记录在 `out/.runs.log` 中。

如果你已经有 v1.x 的输出：
- 旧的 `out/<runId>/<slug>/` 目录不会被动到，但浏览器里也不会再展示。需要清理时再执行：`rm -rf out/2026*/`（按 run-id 前缀）。
- 新记录会以扁平结构重新开始落盘。
- 手动编辑过的记录：如果你在两次抓取之间手动改过 `record.json`，v2.0 会拒绝覆盖。请进入 `out/` 提交改动（`cd out && git add . && git commit -m "manual edits"`），或者加 `--force-overwrite` 直接丢弃。

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
  + extracted audit report text
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
- R1 发现的 audit `reportUrl` PDF/HTML 页面会在 R2 前下载并抽取文本；GitHub blob 链接会优先尝试 raw report URL。配置 `AUDIT_REPORTS_LLM_PROVIDER=openai` 后，已 fetch 的报告文本还会走外部结构化阅读；生成的 `audit_reports` evidence 用于校验审计日期、范围、审计机构和报告链接。
- Claude R2 使用 web reconcile prompt，可以做 fresh WebFetch/WebSearch。OpenAI-compatible R2 使用 evidence-only prompt。启用 `external_first` 时，外部结果必须通过 schema、merge guard 和高风险改动检查才会被接受；否则 R2 fail closed。启用 `external_first_with_claude_fallback` 时，外部结果被拒绝后 Claude R2 会基于原始 R1 record 和已补充的 search evidence 重新运行。
- 搜索请求受限，并通过允许的 fetcher search channel 执行。
- 每个接受的改动都会写入 `changes.json`。

### Normalize And Validate

Consumer normalizer 会做决定性后处理：

- `rootdata-avatar` — `members[].avatarUrl` 在 R2 后确定性填充。已有 OneKey 成员头像 CDN 路径会保留；否则先按精确姓名匹配 RootData project member candidates。如果 project-scoped candidates 漏掉已验证成员，normalizer 会按 `memberName` 直接搜索 RootData people，并要求人物简介能关联当前 protocol。RootData 都没有可用头像时，最后再用已验证 X/LinkedIn 链接或 handle-like pseudonym 生成付费 Unavatar 源 URL。`pbs.twimg.com` 的临时签名 URL 会被拒绝。team 子任务仍输出 `null`；`logo-assets` 会下载源图并把最终 JSON 改写到 OneKey CDN。
- `logo-assets` — 下载/托管 logo 字段到 `out/` 下的共享目录，并把 JSON 改写成 `https://uni.onekey-asset.com/static/logo/...`：
  - `providerLogoUrl` → `out/protocol-logo/`
  - `members[].avatarUrl` → `out/protocol-member-logo/`
  - `audits.items[].auditorLogoUrl` → `out/audit-logo/`
  文件名是确定性的：protocol logo 使用 `<slug>.<ext>`，成员 logo 使用 `<slug>-<member-name>.<ext>`，审计机构 logo 使用 `<auditor>.<ext>`；名称会转小写，标点会折叠成 `-`。本地已有文件会复用，重复 refresh 不会重新下载同一个 logo。审计机构 logo 优先保留当前 record 值，然后复用本地文件和已有 `out/*/record.json`；缺失时再做 RootData project 精确搜索，并托管 RootData 的 `logo` 值。如果 RootData 精确命中的审计机构只有 GitHub 链接没有 logo，会用付费 Unavatar 获取 GitHub org 头像并 rehost。
- `protocol-info-final` — 把 `audits.lastScannedAt` 设为 UTC 今日，并把占位式 `members[].oneLiner` 归零为 `null`。

最终 `record.json` 必须通过 `consumers/protocol-info/schemas/full.json`。

### i18n And Export

如果设置了 `--i18n`，配置的 i18n provider 会翻译 manifest 中的字段。默认是 Claude Haiku；设置 `I18N_PROVIDER=openai` 并提供 OpenAI-compatible 配置后，可改用外部网关。配置来源顺序是一次性 `--openai-*` 参数、shell env、`~/.config/protocol-info/.env`、`<repo>/.env`。如需与 `--max-budget` 一起使用，请同时配置 `OPENAI_INPUT_COST_PER_1M` 和 `OPENAI_OUTPUT_COST_PER_1M`，或传入对应的一次性 pricing 参数。

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
  "providerLogoUrl": "https://uni.onekey-asset.com/static/logo/protocol-logo/pendle.png",
  "displayName": "Pendle",
  "type": "fixed_rate",
  "description": "...",
  "tags": ["yield", "fixed-rate"],
  "establishment": 2021,
  "members": [
    {
      "memberName": "Example Member",
      "memberPosition": "Co-Founder",
      "oneLiner": "Previously built DeFi infrastructure.",
      "avatarUrl": "https://uni.onekey-asset.com/static/logo/protocol-member-logo/pendle-example-member.png",
      "memberLink": {
        "xLink": "https://x.com/example",
        "linkedinLink": null
      }
    }
  ],
  "providerWebsite": "https://...",
  "providerXLink": "https://...",
  "providerDiscordLink": null,
  "status": "draft",
  "fundingRounds": [],
  "audits": {
    "items": [
      {
        "auditor": "OpenZeppelin",
        "auditorLogoUrl": "https://uni.onekey-asset.com/static/logo/audit-logo/openzeppelin.png",
        "date": "2024-05",
        "scope": "Core protocol contracts",
        "reportUrl": "https://..."
      }
    ],
    "lastScannedAt": "2026-04-27"
  },
  "sources": ["https://..."]
}
```

关键约束：

- `type`：`fixed_rate`、`simple_earn`、`staking`
- `status`：crawler 输出应为 `draft`
- `members`：至少 1 个成员
- `members[].oneLiner`：具体且可验证的背景信息，或 `null`；`Unverified`、`TBD`、`N/A`、`暂未提供` 等占位文案会被 normalizer 改回 `null`
- `providerLogoUrl`、`members[].avatarUrl`、`audits.items[].auditorLogoUrl`：绝对 URL 或 `null`；找到 logo 时 normalizer 会改写为 `https://uni.onekey-asset.com/static/logo/...`。成员头像先用 RootData，再用直接 RootData person search，最后才用已验证社交链接或 handle-like pseudonym 的付费 Unavatar。审计机构 logo 优先当前/手工值，然后本地/跨 protocol 缓存，再 RootData project 精确搜索；RootData GitHub 链接可作为付费 Unavatar 兜底。
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

1. 运行 `./run.sh browse` 并打开打印出来的本地 URL，或检查 `out/.runs/<run-id>/summary.tsv`。
2. 对每个 `OK` row，检查 `out/<slug>/record.json`。
3. 在 `Assets` 面板确认 provider、member、auditor logo 都有本地文件，再上传 logo 文件夹。
4. 查看 `findings.json`，确认来源覆盖。
5. 查看 `gaps.json`，确认缺失或弱证据字段。
6. 如果 R2 修改过 R1 输出，查看 `changes.json`。
7. 审核通过后导入 `record.import.json`。

导入示例：

```bash
curl -X POST "$DASHBOARD/api/earn-protocol-info/import" \
  -H "Content-Type: application/json" \
  -d @out/<slug>/record.import.json
```

即使没有 i18n，`record.import.json` 也会包含一条 dashboard locale 为 `en` 的源语言记录。

## 故障排查

### `claude CLI not found`

安装 Claude Code，并确保 `claude` 在 `PATH` 中，或设置 `CLAUDE_BIN`：

```bash
CLAUDE_BIN=/path/to/claude ./run.sh --display-name "Pendle"
```

### RootData disabled

本次运行可加 `--rootdata-key sk-a,sk-b`，或在 shell 中 `export ROOTDATA_API_KEYS=...` / `ROOTDATA_API_KEY=...`，或写到 `~/.config/protocol-info/.env`（推荐）/ `<repo>/.env`。启动横幅会显示 key 数量和来源。不配置时，RootData fetch 和 search channel 会被跳过。付费 Unavatar 使用 `--unavatar-key` 或同样配置位置中的 `UNAVATAR_API_KEY`。

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
out/<slug>/_debug/i18n/
```

成功生成的 locale sidecar 仍会被 post-processing 使用。

### R1 看起来卡住

R1 在运行中会持续写调度 telemetry：

```bash
jq . out/<slug>/_debug/r1/r1-status.json
tail -f out/<slug>/_debug/r1.stderr.log
```

`r1-status.json` 会显示每个 subtask 的 `state`、`pid`、`elapsed_ms`、
`timeout_ms` 和 `error_kind`。Claude 调用默认 30 分钟 wall-clock watchdog；
可以用 `CLAUDE_TIMEOUT_MS` 或 `R1_CLAUDE_TIMEOUT_MS` 调整。只有明确要禁用
watchdog 时才把值设为 `0`。

### 输出路径变化

当前结构是 protocol-first：

```text
out/<slug>/
out/.runs/<run-id>/summary.tsv
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
