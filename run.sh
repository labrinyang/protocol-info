#!/bin/bash
#
# 通过 claude -p 无头模式批量抓取 EarnProtocolInfo 记录。
#
# 双轮管线（设置 ROOTDATA_API_KEY 时）：
#   Round 1  Claude 网页抓取
#   API      consumers/protocol-info/fetchers/rootdata.mjs 与 Round 1 并行运行
#   Round 2  恢复会话，用 API 证据对 Claude 输出进行对账
#
# 未设置 ROOTDATA_API_KEY 时退化为单轮模式。
#
# 用法：
#   # 单个 provider（最少需要 --display-name 和 --type）
#   ./run.sh --display-name "f(x)Protocol" --type simple_earn
#
#   # 可选参数
#   ./run.sh --display-name "Pendle" --type fixed_rate \
#            --slug pendle --hints "Yield trading protocol" --rootdata-id 874
#
#   # 批量模式（用 --batch 分隔多组）
#   ./run.sh \
#     --batch --display-name "Pendle" --type fixed_rate --slug pendle \
#     --batch --display-name "Morpho" --type simple_earn --slug morpho
#
#   # 通用选项
#   ./run.sh --model sonnet --display-name "Pendle" --type fixed_rate
#   ./run.sh --max-turns 40 --display-name "Pendle" --type fixed_rate
#   ./run.sh --max-budget 2.00 --display-name "Pendle" --type fixed_rate
#   ./run.sh --dry-run --display-name "Pendle" --type fixed_rate
#   ./run.sh --parallel 4 --batch --display-name "A" --type t ... --batch ...
#
#   # i18n 翻译（跑完主管线后触发，Haiku 模型）
#   ./run.sh --i18n all --display-name "Pendle" --type fixed_rate
#   ./run.sh --i18n zh_CN,ja_JP,en_US --display-name "Pendle" --type fixed_rate
#   ./run.sh --i18n none --display-name "Pendle" --type fixed_rate      # 显式跳过
#   ./run.sh --display-name "Pendle" --type fixed_rate                  # tty 下交互问
#   ./run.sh --i18n all --i18n-parallel 16 --i18n-model claude-haiku-4-5-20251001 ...
#
# 环境变量：
#   CLAUDE_BIN          claude CLI 路径（默认: "claude"）
#   ROOTDATA_API_KEY    RootData API 密钥（可选；启用 Round 2）
#
# 输出（每次运行生成带时间戳的子目录,每 provider 一个子目录）：
#   out/<ts>/summary.tsv                 结果汇总表 (含 i18n 成功率列)
#   out/<ts>/<slug>/record.json          源语言主记录 (schema 通过,DB 入库用)
#   out/<ts>/<slug>/record.full.json     内联 i18n 的合并版 (仅翻译后生成)
#   out/<ts>/<slug>/meta.json            运行元数据 {r1,r2,rootdata,i18n}
#   out/<ts>/<slug>/_debug/              审计 / 排障产物
#     r1.envelope.json, r1.stderr.log    Round 1
#     r2.envelope.json, r2.stderr.log    Round 2 (如适用)
#     rootdata.json,    rootdata.stderr.log  API 证据包 (如适用)
#     parse.stderr.log                   仅 PARSE_FAIL 时
#     schema.stderr.log                  仅 SCHEMA_FAIL 时
#     i18n/<locale>.json, <locale>.envelope.json, failures.log  i18n 启用时

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-load .env. Lookup order:
#   1. $SCRIPT_DIR/.env               (standalone CLI use — never committed)
#   2. $HOME/.config/protocol-info/.env  (user config, works for plugin install where
#                                         $SCRIPT_DIR is the read-only plugin cache)
# 已设置的 env 变量(export ROOTDATA_API_KEY=...)优先于文件,因为 set +a 不会覆盖。
for _env_candidate in "$SCRIPT_DIR/.env" "$HOME/.config/protocol-info/.env"; do
  if [[ -f "$_env_candidate" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$_env_candidate"
    set +a
    break
  fi
done
unset _env_candidate
SCHEMA_FILE="$SCRIPT_DIR/consumers/protocol-info/schemas/full.json"
SYSTEM_PROMPT_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/system.md"
USER_TMPL_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/user.md.tmpl"
I18N_SYSTEM_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/i18n.system.md"
I18N_TMPL_FILE="$SCRIPT_DIR/consumers/protocol-info/prompts/i18n.user.md.tmpl"
I18N_SCHEMA_FILE="$SCRIPT_DIR/consumers/protocol-info/schemas/i18n.json"
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$SCRIPT_DIR/out/$RUN_TS"
SUMMARY_FILE="$OUT_DIR/summary.tsv"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MODEL=""
MAX_TURNS=40
MAX_TURNS_R2=10
MAX_BUDGET_USD="2.00"
MAX_BUDGET_R2="0.50"
MAX_BUDGET_I18N="0.10"
DRY_RUN=0
PARALLEL=1
I18N_ARG=""                                  # ""=ask, "none"=skip, "all", or "zh_CN,ja_JP,..."
I18N_PARALLEL=8
I18N_MODEL="claude-haiku-4-5-20251001"
I18N_SELECTED=()                             # filled in by i18n_resolve_selection

# ── slugify: displayName -> slug ──────────────────────────────────────
slugify() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//'
}

# ── flush_provider: 将当前累积的参数打包为一个 provider JSON 并推入数组 ──
PROVIDERS=()
_dn="" _type="" _slug="" _hints="" _rid=""

flush_provider() {
  [[ -z "$_dn" && -z "$_type" ]] && return 0
  if [[ -z "$_dn" ]]; then
    echo "错误: --display-name 为必填参数" >&2; exit 1
  fi
  local s="${_slug:-$(slugify "$_dn")}"
  PROVIDERS+=("$(jq -nc \
    --arg slug "$s" \
    --arg provider "$s" \
    --arg displayName "$_dn" \
    --arg type "$_type" \
    --arg hints "$_hints" \
    --arg rid "$_rid" \
    '{slug:$slug, provider:$provider, displayName:$displayName, type:$type, hints:$hints}
     + (if $rid != "" then {rootdataId:($rid|tonumber)} else {} end)')")
  _dn="" _type="" _slug="" _hints="" _rid=""
}

# ── 参数解析 ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)        MODEL="$2"; shift 2 ;;
    --max-turns)    MAX_TURNS="$2"; shift 2 ;;
    --max-budget)   MAX_BUDGET_USD="$2"; shift 2 ;;
    --parallel)     PARALLEL="$2"; shift 2 ;;
    --i18n)         I18N_ARG="$2"; shift 2 ;;
    --i18n-parallel) I18N_PARALLEL="$2"; shift 2 ;;
    --i18n-model)   I18N_MODEL="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --display-name) _dn="$2"; shift 2 ;;
    --type)         _type="$2"; shift 2 ;;
    --slug)         _slug="$2"; shift 2 ;;
    --hints)        _hints="$2"; shift 2 ;;
    --rootdata-id)  _rid="$2"; shift 2 ;;
    --batch)        flush_provider; shift ;;
    -h|--help)
      grep -E '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "未知参数: $1" >&2; exit 1 ;;
    *)
      echo "未知参数: $1（所有 provider 信息需通过 --display-name / --type 等 flag 传入）" >&2; exit 1 ;;
  esac
done
flush_provider

if [[ ${#PROVIDERS[@]} -eq 0 ]]; then
  echo "错误: 至少需要提供一个 provider（--display-name + --type）" >&2
  echo "用法: ./run.sh --display-name \"Protocol Name\" --type simple_earn" >&2
  echo "批量: ./run.sh --batch --display-name \"A\" --type t1 --batch --display-name \"B\" --type t2" >&2
  exit 1
fi

if ! [[ "$PARALLEL" =~ ^[0-9]+$ ]] || [[ $PARALLEL -lt 1 ]]; then
  echo "错误: --parallel 必须是正整数（当前: $PARALLEL）" >&2; exit 1
fi
if ! [[ "$I18N_PARALLEL" =~ ^[0-9]+$ ]] || [[ $I18N_PARALLEL -lt 1 ]]; then
  echo "错误: --i18n-parallel 必须是正整数（当前: $I18N_PARALLEL）" >&2; exit 1
fi
# dry-run 强制顺序，便于阅读 prompt 输出
[[ "$DRY_RUN" -eq 1 ]] && PARALLEL=1

command -v "$CLAUDE_BIN" >/dev/null || { echo "claude CLI not found ($CLAUDE_BIN)" >&2; exit 127; }
command -v jq           >/dev/null || { echo "jq required" >&2; exit 127; }
command -v node         >/dev/null || { echo "node required" >&2; exit 127; }

ROOTDATA_ENABLED=0
if [[ -n "${ROOTDATA_API_KEY:-}" ]]; then
  ROOTDATA_ENABLED=1
fi

mkdir -p "$OUT_DIR" "$OUT_DIR/.summary-rows" "$OUT_DIR/.worker-logs"
printf "slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\n" > "$SUMMARY_FILE"

MODEL_FLAG=()
[[ -n "$MODEL" ]] && MODEL_FLAG=(--model "$MODEL")

SELECTED_JSON=$(printf '%s\n' "${PROVIDERS[@]}" | jq -s '.')
TOTAL=$(echo "$SELECTED_JSON" | jq 'length')

echo "=== Protocol-info crawl ==="
echo "Providers:   $TOTAL"
echo "Model:       ${MODEL:-default}"
echo "Max turns:   $MAX_TURNS"
echo "Max budget:  \$${MAX_BUDGET_USD} / provider"
echo "Parallel:    $PARALLEL"
if [[ $ROOTDATA_ENABLED -eq 1 ]]; then
  echo "RootData:    enabled (Round 2)"
else
  echo "RootData:    disabled (single-round)"
fi
case "$I18N_ARG" in
  "")    i18n_label="ask after main run (skip if no tty)" ;;
  none)  i18n_label="skip" ;;
  all)   i18n_label="all languages (from manifest catalog)" ;;
  *)     i18n_label="$I18N_ARG" ;;
esac
echo "i18n:        $i18n_label [model=$I18N_MODEL, parallel=$I18N_PARALLEL]"
echo "Out dir:     $OUT_DIR"
echo ""

SCHEMA_INLINE=$(cat "$SCHEMA_FILE")
SYSTEM_PROMPT=$(cat "$SYSTEM_PROMPT_FILE")
I18N_SYSTEM_PROMPT=$(cat "$I18N_SYSTEM_FILE")
I18N_SCHEMA_INLINE=$(cat "$I18N_SCHEMA_FILE")

# ── run_one: 处理单个 provider（顺序或作为并行 worker 运行） ────────────
# 所有进度打印进 stdout；失败时原始 Claude 输出回显到 stderr。
# 通过 $OUT_DIR/.summary-rows/<idx>-<slug>.tsv 写汇总行，避免并发写入 summary.tsv。
run_one() {
  local INDEX="$1"
  local provider_json="$2"
  local slug=$(echo "$provider_json"     | jq -r '.slug')
  local provider=$(echo "$provider_json" | jq -r '.provider')
  local display=$(echo "$provider_json"  | jq -r '.displayName')
  local type=$(echo "$provider_json"     | jq -r '.type')
  local hints=$(echo "$provider_json"    | jq -r '.hints // ""')
  local rootdata_id=$(echo "$provider_json" | jq -r '.rootdataId // empty')
  local summary_row_file="$OUT_DIR/.summary-rows/$(printf '%04d' "$INDEX")-$slug.tsv"

  if [[ -n "$type" ]]; then
    echo "[$INDEX/$TOTAL] $slug ($type)"
  else
    echo "[$INDEX/$TOTAL] $slug (type: model-inferred)"
  fi

  # Render user prompt template
  user_prompt=$(jq -rn \
    --arg slug "$slug" \
    --arg provider "$provider" \
    --arg display "$display" \
    --arg type "$type" \
    --arg hints "$hints" \
    --arg schema "$SCHEMA_INLINE" \
    --rawfile tmpl "$USER_TMPL_FILE" \
    '$tmpl
      | gsub("{{SLUG}}"; $slug)
      | gsub("{{PROVIDER}}"; $provider)
      | gsub("{{DISPLAY_NAME}}"; $display)
      | gsub("{{TYPE}}"; $type)
      | gsub("{{HINTS}}"; $hints)
      | gsub("{{SCHEMA}}"; $schema)')

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "--- user prompt ---"
    echo "$user_prompt"
    echo "--- end ---"
    return 0
  fi

  local slug_dir="$OUT_DIR/$slug"
  local debug_dir="$slug_dir/_debug"
  mkdir -p "$slug_dir" "$debug_dir"

  local rec="$slug_dir/record.json"
  local rec_full="$slug_dir/record.full.json"
  local meta="$slug_dir/meta.json"

  local r1_env="$debug_dir/r1/metadata.envelope.json"
  local r1_err="$debug_dir/r1.stderr.log"
  local r2_env="$debug_dir/r2.envelope.json"
  local r2_err="$debug_dir/r2.stderr.log"
  local rootdata_pkt="$debug_dir/rootdata.json"
  local rootdata_err="$debug_dir/rootdata.stderr.log"
  local schema_err="$debug_dir/schema.stderr.log"

  # ── Phase 1: Fetch evidence (must complete before R1 so subtask prompts see it) ──

  api_exit=1
  if [[ $ROOTDATA_ENABLED -eq 1 ]]; then
    set +e
    node "$SCRIPT_DIR/framework/cli/fetch.mjs" \
      --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
      --slug "$slug" \
      --display-name "$display" \
      --hints "$hints" \
      ${rootdata_id:+--rootdata-id "$rootdata_id"} \
      --output "$rootdata_pkt" \
      2> "$rootdata_err"
    api_exit=$?
    set -e
  fi

  # ── Phase 2: R1 fan-out (4 parallel subtasks; evidence now ready on disk) ──

  set +e
  node "$SCRIPT_DIR/framework/cli/r1.mjs" \
    --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
    --slug "$slug" \
    --provider "$provider" \
    --display-name "$display" \
    ${type:+--type "$type"} \
    --hints "$hints" \
    ${MODEL:+--model "$MODEL"} \
    --evidence "$rootdata_pkt" \
    --record-out "$rec" \
    --debug-dir "$debug_dir/r1" \
    --findings-out "$slug_dir/findings.json" \
    --gaps-out "$slug_dir/gaps.json" \
    --handoff-out "$slug_dir/handoff_notes.json" \
    > /dev/null 2> "$r1_err"
  r1_exit=$?
  set -e

  # ── Phase 2: Extract Round 1 result ──

  if [[ $r1_exit -ne 0 ]]; then
    echo "  -> CRAWL_FAIL (exit $r1_exit); see $r1_err"
    echo "     --- last stderr lines ---" >&2
    tail -20 "$r1_err" 2>/dev/null | sed 's/^/     /' >&2
    echo "" >&2
    printf "%s\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t$(if [[ $ROOTDATA_ENABLED -eq 1 ]]; then echo "exit_$api_exit"; else echo "disabled"; fi)\n" "$slug" > "$summary_row_file"
    return 0
  fi

  if [[ ! -s "$rec" ]]; then
    echo "  -> CRAWL_FAIL (no slice produced by r1.mjs); see $r1_env $r1_err"
    tail -20 "$r1_err" 2>/dev/null | sed 's/^/     /' >&2
    printf "%s\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t-\n" "$slug" > "$summary_row_file"
    return 0
  fi

  r1_cost=$(jq -r '.total_cost_usd // 0' "$r1_env" 2>/dev/null || echo 0)
  [[ "$r1_cost" =~ ^[0-9]+(\.[0-9]+)?$ ]] || r1_cost=0
  final_source="r1"
  api_status="disabled"
  r2_cost="0"
  overrides_applied=""
  member_candidates_fed=0
  funding_severity="none"

  # ── Phase 3: Round 2 reconciliation ──
  # R2 runs a fresh Claude session per round (no session-resume — incompatible
  # with fan-out R1, where each subtask has its own session_id). The reconcile
  # prompt receives the merged record + full evidence + handoff_notes inline.
  api_status=$(if [[ $ROOTDATA_ENABLED -eq 1 && $api_exit -eq 0 ]]; then echo "ok"; elif [[ $ROOTDATA_ENABLED -eq 1 ]]; then echo "exit_$api_exit"; else echo "disabled"; fi)

  # Apply validated_overrides via jq patch (independent of R2 — runs whenever rootdata
  # produced a packet; preserves Phase-2/3 behavior. Will be re-evaluated in Phase 6.)
  if [[ $ROOTDATA_ENABLED -eq 1 && $api_exit -eq 0 && -f "$rootdata_pkt" ]]; then
    override_website=$(jq -r '.rootdata.validated_overrides.providerWebsite // empty' "$rootdata_pkt")
    override_xlink=$(jq -r '.rootdata.validated_overrides.providerXLink // empty' "$rootdata_pkt")
    overrides_list=()

    if [[ -n "$override_website" ]]; then
      jq --arg w "$override_website" '.providerWebsite=$w' "$rec" > "$rec.tmp" && mv "$rec.tmp" "$rec"
      overrides_list+=("providerWebsite")
    fi
    if [[ -n "$override_xlink" ]]; then
      jq --arg x "$override_xlink" '.providerXLink=$x' "$rec" > "$rec.tmp" && mv "$rec.tmp" "$rec"
      overrides_list+=("providerXLink")
    fi
    overrides_applied=$(printf '%s,' "${overrides_list[@]}" 2>/dev/null | sed 's/,$//')
  fi

  # ── Phase 3.5: Evidence-diff enrichment (post-R1, pre-R2) ──
  if [[ $ROOTDATA_ENABLED -eq 1 && $api_exit -eq 0 && -f "$rootdata_pkt" ]]; then
    set +e
    node "$SCRIPT_DIR/framework/cli/evidence-diff.mjs" \
      --evidence-in "$rootdata_pkt" \
      --record-in "$rec" \
      --evidence-out "$rootdata_pkt" \
      2>> "$debug_dir/evidence-diff.stderr.log"
    set -e
  fi

  # ── Phase 3.6: R2 reconcile / synthesis ──
  set +e
  node "$SCRIPT_DIR/framework/cli/r2.mjs" \
    --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
    --record-in "$rec" \
    --findings-in "$slug_dir/findings.json" \
    --gaps-in "$slug_dir/gaps.json" \
    --handoff-in "$slug_dir/handoff_notes.json" \
    --evidence "$rootdata_pkt" \
    --record-out "$rec.r2" \
    --findings-out "$slug_dir/findings.json.r2" \
    --changes-out "$slug_dir/changes.json.r2" \
    --gaps-out "$slug_dir/gaps.json.r2" \
    --debug-dir "$debug_dir/r2" \
    2> "$r2_err"
  r2_exit=$?
  set -e

  if [[ $r2_exit -eq 0 && -s "$rec.r2" ]]; then
    mv "$rec.r2" "$rec"
    [[ -f "$slug_dir/findings.json.r2" ]] && mv "$slug_dir/findings.json.r2" "$slug_dir/findings.json"
    [[ -f "$slug_dir/changes.json.r2" ]] && mv "$slug_dir/changes.json.r2" "$slug_dir/changes.json"
    [[ -f "$slug_dir/gaps.json.r2" ]] && mv "$slug_dir/gaps.json.r2" "$slug_dir/gaps.json"
    final_source="r2"
    # Aggregate R2 cost across rounds from envelope files
    r2_cost=$(find "$debug_dir/r2" -maxdepth 1 -name 'reconcile.round*.envelope.json' 2>/dev/null \
              | xargs -I {} jq -r '.total_cost_usd // 0' {} 2>/dev/null \
              | awk 'BEGIN{s=0} {s+=$1} END{printf "%.6f", s}' 2>/dev/null || echo 0)
    [[ "$r2_cost" =~ ^[0-9]+(\.[0-9]+)?$ ]] || r2_cost=0
  else
    echo "  -> R2 reconcile failed (exit $r2_exit); keeping R1 record" >&2
    rm -f "$rec.r2" "$slug_dir/findings.json.r2" "$slug_dir/changes.json.r2" "$slug_dir/gaps.json.r2"
  fi

  # ── Phase 4: Deterministic final normalizer (replaces bash audits.lastScannedAt) ──
  # Safety net: if R2 was skipped/failed, changes.json may not exist yet.
  [[ -f "$slug_dir/changes.json" ]] || echo "[]" > "$slug_dir/changes.json"

  set +e
  node "$SCRIPT_DIR/framework/cli/normalize.mjs" \
    --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
    --record-in "$rec" \
    --evidence "$rootdata_pkt" \
    --changes-in "$slug_dir/changes.json" \
    --gaps-in "$slug_dir/gaps.json" \
    --record-out "$rec.normalized" \
    --changes-out "$slug_dir/changes.json.normalized" \
    --gaps-out "$slug_dir/gaps.json.normalized" \
    2> "$debug_dir/normalize.stderr.log"
  norm_exit=$?
  set -e

  if [[ $norm_exit -eq 0 && -s "$rec.normalized" ]]; then
    mv "$rec.normalized" "$rec"
    [[ -f "$slug_dir/changes.json.normalized" ]] && mv "$slug_dir/changes.json.normalized" "$slug_dir/changes.json"
    [[ -f "$slug_dir/gaps.json.normalized" ]] && mv "$slug_dir/gaps.json.normalized" "$slug_dir/gaps.json"
  else
    echo "  -> normalizer failed (exit $norm_exit); keeping pre-normalize record" >&2
    rm -f "$rec.normalized" "$slug_dir/changes.json.normalized" "$slug_dir/gaps.json.normalized"
  fi

  # Validate
  set +e
  node "$SCRIPT_DIR/framework/schema-validator.mjs" --schema "$SCHEMA_FILE" "$rec" > "$schema_err" 2>&1
  schema_exit=$?
  set -e

  members=$(jq -r '.members | length // 0' "$rec" 2>/dev/null || echo "-")
  funding=$(jq -r '.fundingRounds | length // 0' "$rec" 2>/dev/null || echo "-")
  audits_n=$(jq -r '.audits.items | length // 0' "$rec" 2>/dev/null || echo "-")

  if [[ $schema_exit -eq 0 ]]; then
    echo "  -> OK  members=$members funding=$funding audits=$audits_n source=$final_source"
    printf "%s\tOK\t%s\t%s\t%s\tpass\t%s\t%s\n" "$slug" "$members" "$funding" "$audits_n" "$final_source" "$api_status" > "$summary_row_file"
    rm -f "$schema_err"
  else
    echo "  -> SCHEMA_FAIL  members=$members funding=$funding audits=$audits_n source=$final_source"
    sed 's/^/        /' "$schema_err" >&2
    printf "%s\tSCHEMA_FAIL\t%s\t%s\t%s\tfail\t%s\t%s\n" "$slug" "$members" "$funding" "$audits_n" "$final_source" "$api_status" > "$summary_row_file"
  fi

  # ── Write meta.json (运行元数据,不论 schema pass/fail) ──
  local r1_turns_v=$(jq -r '.num_turns // 0' "$r1_env" 2>/dev/null || echo 0)
  local r2_turns_v=0
  if [[ -d "$debug_dir/r2" ]]; then
    r2_turns_v=$(find "$debug_dir/r2" -maxdepth 1 -name 'reconcile.round*.envelope.json' 2>/dev/null \
                 | xargs -I {} jq -r '.num_turns // 0' {} 2>/dev/null \
                 | awk 'BEGIN{s=0} {s+=$1} END{print s+0}' 2>/dev/null || echo 0)
    [[ "$r2_turns_v" =~ ^[0-9]+$ ]] || r2_turns_v=0
  fi
  jq -n \
    --argjson r1_cost "$r1_cost" \
    --argjson r1_turns "$r1_turns_v" \
    --argjson r2_cost "$r2_cost" \
    --argjson r2_turns "$r2_turns_v" \
    --arg source_used "$final_source" \
    --arg api_status "$api_status" \
    --argjson members_fed "$member_candidates_fed" \
    --arg severity "$funding_severity" \
    --arg overrides "$overrides_applied" \
    '{
      r1: { cost_usd: $r1_cost, turns: $r1_turns },
      r2: (if $r2_turns > 0 then { cost_usd: $r2_cost, turns: $r2_turns } else null end),
      source_used: $source_used,
      rootdata: (if $api_status == "disabled" then null
                 elif $api_status == "ok" then {
                   used: true,
                   member_candidates_fed: $members_fed,
                   funding_discrepancy_severity: $severity,
                   overrides_applied: ($overrides | split(",") | map(select(. != "")))
                 }
                 else { used: false, status: $api_status } end),
      i18n: null
    }' > "$meta"
}

# ── i18n: 用 Haiku 把主记录翻译成目标语言 ───────────────────────────────
# 实际翻译走 framework/cli/i18n.mjs (per slug)。下面只保留 selection 解析,
# 保证 --i18n flag 行为不变(I18N_SELECTED[] 数组)。

# 解析 I18N_ARG → I18N_SELECTED 数组（含校验和未知 code 过滤）
i18n_resolve_selection() {
  I18N_SELECTED=()
  local raw=()
  local entry

  if [[ -z "$I18N_ARG" ]]; then
    # 没传 --i18n 一律静默跳过(交互式选择已下线;Phase 8 会重新评估)。
    echo "i18n: no --i18n flag — skipping translation. Pass --i18n all | zh_CN,ja_JP,... | none to control explicitly." >&2
    return 0
  elif [[ "$I18N_ARG" == "none" ]]; then
    return 0
  elif [[ "$I18N_ARG" == "all" ]]; then
    while IFS= read -r code; do
      [[ -n "$code" ]] && raw+=("$code")
    done < <(jq -r '.i18n.locale_catalog[].code' "$SCRIPT_DIR/consumers/protocol-info/manifest.json")
  else
    local IFS_save="$IFS"
    IFS=',' read -ra raw <<< "$I18N_ARG"
    IFS="$IFS_save"
  fi

  # Trim whitespace; CLI (framework/cli/i18n.mjs) validates against manifest catalog
  local code trimmed
  for code in "${raw[@]}"; do
    trimmed="${code// /}"
    [[ -z "$trimmed" ]] && continue
    I18N_SELECTED+=("$trimmed")
  done
}

# ── Dispatcher: 顺序或有界并发 ────────────────────────────────────────
if [[ $PARALLEL -le 1 ]]; then
  INDEX=0
  while IFS= read -r provider_json; do
    INDEX=$((INDEX + 1))
    run_one "$INDEX" "$provider_json"
  done < <(echo "$SELECTED_JSON" | jq -c '.[]')
else
  echo "Dispatching $TOTAL providers with parallelism=$PARALLEL..."
  INDEX=0
  pids=()
  worker_logs=()
  while IFS= read -r provider_json; do
    INDEX=$((INDEX + 1))
    slug=$(echo "$provider_json" | jq -r '.slug')
    wlog="$OUT_DIR/.worker-logs/$(printf '%04d' "$INDEX")-$slug.log"
    worker_logs+=("$wlog")
    echo "[$INDEX/$TOTAL] $slug: dispatched"
    # 合并 stdout + stderr 到单个 worker log，避免并行输出错乱
    run_one "$INDEX" "$provider_json" > "$wlog" 2>&1 &
    pids+=($!)
    # 达到并发上限则等待最老的 worker 完成再派发下一个
    if [[ ${#pids[@]} -ge $PARALLEL ]]; then
      wait "${pids[0]}" || true
      pids=("${pids[@]:1}")
    fi
  done < <(echo "$SELECTED_JSON" | jq -c '.[]')
  wait
  echo ""
  echo "=== Worker logs (in dispatch order) ==="
  for wlog in "${worker_logs[@]}"; do
    cat "$wlog"
  done
fi

# ── i18n 阶段 (在主管线全部结束后,对 status=OK 的 slug 翻译) ────────────
OK_SLUGS=()
shopt -s nullglob
for row in "$OUT_DIR/.summary-rows"/*.tsv; do
  status=$(awk -F'\t' '{print $2}' "$row")
  if [[ "$status" == "OK" ]]; then
    slug=$(awk -F'\t' '{print $1}' "$row")
    OK_SLUGS+=("$slug")
  fi
done
shopt -u nullglob

# dry-run 跳过 i18n
if [[ "$DRY_RUN" -ne 1 ]]; then
  i18n_resolve_selection
  if [[ ${#OK_SLUGS[@]} -gt 0 && ${#I18N_SELECTED[@]} -gt 0 ]]; then
    I18N_LOCALES_LIST=$(IFS=','; echo "${I18N_SELECTED[*]}")
    echo ""
    echo "=== i18n translation (Haiku) ==="
    echo "Records:  ${#OK_SLUGS[@]}"
    echo "Locales:  ${#I18N_SELECTED[@]} (${I18N_SELECTED[*]})"
    echo "Parallel: $I18N_PARALLEL"
    echo "Model:    $I18N_MODEL"
    echo ""
    for _slug in "${OK_SLUGS[@]}"; do
      node "$SCRIPT_DIR/framework/cli/i18n.mjs" \
        --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
        --record "$OUT_DIR/$_slug/record.json" \
        --locales "$I18N_LOCALES_LIST" \
        --output-dir "$OUT_DIR/$_slug/_debug/i18n" \
        --parallel "$I18N_PARALLEL" \
        ${I18N_MODEL:+--model "$I18N_MODEL"} \
        2>&1 | sed "s/^/[$_slug] /"
    done
    unset _slug
  fi
fi

# ── Post-processing: dashboard export + meta patch + record.full.json ──
# Runs unconditionally on OK slugs. Even when no i18n was requested,
# post.mjs still produces record.import.json with just the source-locale entry.
if [[ "$DRY_RUN" -ne 1 ]] && [[ ${#OK_SLUGS[@]} -gt 0 ]]; then
  for _slug in "${OK_SLUGS[@]}"; do
    node "$SCRIPT_DIR/framework/cli/post.mjs" \
      --manifest "$SCRIPT_DIR/consumers/protocol-info/manifest.json" \
      --slug-dir "$OUT_DIR/$_slug" \
      || echo "[post] $_slug failed; record.import.json may be missing" >&2
  done
  unset _slug
fi

# ── 合并 per-slug summary 行 + i18n 列 → summary.tsv ─────────────────
{
  printf "slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\ti18n\n"
  shopt -s nullglob
  for row in "$OUT_DIR/.summary-rows"/*.tsv; do
    slug=$(awk -F'\t' '{print $1}' "$row")
    i18n_col="-"
    if [[ ${#I18N_SELECTED[@]} -gt 0 ]]; then
      i18n_dir="$OUT_DIR/$slug/_debug/i18n"
      if [[ -d "$i18n_dir" ]]; then
        ok=$(find "$i18n_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.envelope.json' | wc -l | tr -d ' ')
        i18n_col="$ok/${#I18N_SELECTED[@]}"
      else
        i18n_col="0/${#I18N_SELECTED[@]}"
      fi
    fi
    printf "%s\t%s\n" "$(cat "$row")" "$i18n_col"
  done
  shopt -u nullglob
} > "$SUMMARY_FILE.tmp" && mv "$SUMMARY_FILE.tmp" "$SUMMARY_FILE"

echo ""
echo "=== Summary ==="
column -t -s "$(printf '\t')" "$SUMMARY_FILE"
echo ""
echo "Next: review $OUT_DIR/<slug>/record.json (or record.full.json if i18n). Import via dashboard CRUD."
