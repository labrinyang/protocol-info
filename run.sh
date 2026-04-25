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

# 19-locale catalog: "code|中文名|English name"
I18N_LOCALES=(
  "bn|孟加拉语|Bengali"
  "de|德语|German"
  "en_US|英语(美国)|English (US)"
  "es|西班牙语|Spanish"
  "fr_FR|法语|French"
  "hi_IN|印地语|Hindi"
  "id|印尼语|Indonesian"
  "it_IT|意大利语|Italian"
  "ja_JP|日语|Japanese"
  "ko_KR|韩语|Korean"
  "pt|葡萄牙语|Portuguese"
  "pt_BR|葡萄牙语(巴西)|Portuguese (Brazil)"
  "ru|俄语|Russian"
  "th_TH|泰语|Thai"
  "uk_UA|乌克兰语|Ukrainian"
  "vi|越南语|Vietnamese"
  "zh_CN|简体中文|Simplified Chinese"
  "zh_HK|繁体中文(香港)|Traditional Chinese (Hong Kong)"
  "zh_TW|繁体中文(台湾)|Traditional Chinese (Taiwan)"
)

# Lookup a locale's English display name by code. Echos name (or empty on miss).
locale_name_for() {
  local target="$1"
  local entry rest
  for entry in "${I18N_LOCALES[@]}"; do
    if [[ "${entry%%|*}" == "$target" ]]; then
      rest="${entry#*|}"
      echo "${rest##*|}"
      return 0
    fi
  done
  return 1
}

# 把我们的 locale code (en_US / zh_CN / ja_JP / ...) 映射成 dashboard 期望的格式
# (en / zh-cn / ja / ...). 规则:仅当语言有多种 region 变体时保留 region (pt_BR → pt-br),
# 否则只保留 language code (en_US → en, fr_FR → fr).
# TODO: dashboard 文档说支持 21 种 locale,我们目前 19 种;待 dashboard 给清单后补两个。
dashboard_locale_for() {
  case "$1" in
    en_US) echo "en" ;;
    fr_FR) echo "fr" ;;
    hi_IN) echo "hi" ;;
    it_IT) echo "it" ;;
    ja_JP) echo "ja" ;;
    ko_KR) echo "ko" ;;
    th_TH) echo "th" ;;
    uk_UA) echo "uk" ;;
    pt_BR) echo "pt-br" ;;
    zh_CN) echo "zh-cn" ;;
    zh_HK) echo "zh-hk" ;;
    zh_TW) echo "zh-tw" ;;
    bn|de|es|id|pt|ru|vi) echo "$1" ;;
    *) echo "$1" | tr '[:upper:]' '[:lower:]' | tr '_' '-' ;;
  esac
}

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
  all)   i18n_label="all ${#I18N_LOCALES[@]} languages" ;;
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

  SESSION_ID=$(jq -r '.session_id // empty' "$r1_env" 2>/dev/null)
  r1_cost=$(jq -r '.total_cost_usd // 0' "$r1_env" 2>/dev/null || echo 0)
  [[ "$r1_cost" =~ ^[0-9]+(\.[0-9]+)?$ ]] || r1_cost=0
  final_source="r1"
  api_status="disabled"
  r2_cost="0"
  overrides_applied=""
  member_candidates_fed=0
  funding_severity="none"

  # ── Phase 3: Round 2 reconciliation ──
  # Phase 6.3 will reintroduce a clean Node-based R2 invocation
  # (framework/cli/r2.mjs) operating on the merged fan-out record.
  # Until then, the merged R1 record is the final record.
  api_status=$(if [[ $ROOTDATA_ENABLED -eq 1 && $api_exit -eq 0 ]]; then echo "ok"; elif [[ $ROOTDATA_ENABLED -eq 1 ]]; then echo "exit_$api_exit"; else echo "disabled"; fi)
  # final_source stays "r1" (the merged fan-out record is the final record)

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

  # ── Phase 4: Post-processing (same as original) ──

  if jq -e '.audits.items | type == "array"' "$rec" >/dev/null 2>&1; then
    today=$(date -u +%Y-%m-%d)
    jq --arg today "$today" '.audits.lastScannedAt = $today' "$rec" \
      > "$rec.tmp" && mv "$rec.tmp" "$rec"
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
  [[ -f "$r2_env" ]] && r2_turns_v=$(jq -r '.num_turns // 0' "$r2_env" 2>/dev/null || echo 0)
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

# 交互挑语言（无 --i18n flag + tty 时触发）。每行一个 code 写到 stdout；提示 UI 走 stderr。
# 调用前已经确认 stdin 是 tty,这里不再自行检测。
i18n_pick_interactive() {
  {
    echo ""
    echo "Translate successful records to i18n? (Haiku: $I18N_MODEL)"
    echo "  [a] all ${#I18N_LOCALES[@]} languages"
    echo "  [s] select (comma-separated codes)"
    echo "  [n] skip (default)"
    printf "Choice [n]: "
  } >&2

  local choice=""
  read -r choice
  choice="${choice:-n}"

  local entry code rest cn_name
  case "$choice" in
    a|A|all)
      for entry in "${I18N_LOCALES[@]}"; do echo "${entry%%|*}"; done
      ;;
    s|S|select)
      echo "" >&2
      echo "Available locales:" >&2
      for entry in "${I18N_LOCALES[@]}"; do
        code="${entry%%|*}"
        rest="${entry#*|}"
        cn_name="${rest%%|*}"
        printf "  %-8s %s\n" "$code" "$cn_name" >&2
      done
      printf "Codes (comma-separated, e.g. zh_CN,ja_JP,en_US): " >&2
      local codes_input=""
      read -r codes_input
      echo "$codes_input" | tr ',' '\n' | awk 'NF' | sed 's/[[:space:]]//g'
      ;;
    *) ;;
  esac
}

# 解析 I18N_ARG → I18N_SELECTED 数组（含校验和未知 code 过滤）
i18n_resolve_selection() {
  I18N_SELECTED=()
  local raw=()
  local entry

  if [[ -z "$I18N_ARG" ]]; then
    # tty 下交互问;headless(plugin / CI / </dev/null)下告知并静默跳过
    if [[ ! -t 0 ]]; then
      echo "i18n: stdin is not a tty — skipping translation. Pass --i18n all | zh_CN,ja_JP,... | none to control explicitly." >&2
      return 0
    fi
    while IFS= read -r code; do
      [[ -n "$code" ]] && raw+=("$code")
    done < <(i18n_pick_interactive)
  elif [[ "$I18N_ARG" == "none" ]]; then
    return 0
  elif [[ "$I18N_ARG" == "all" ]]; then
    for entry in "${I18N_LOCALES[@]}"; do
      raw+=("${entry%%|*}")
    done
  else
    local IFS_save="$IFS"
    IFS=',' read -ra raw <<< "$I18N_ARG"
    IFS="$IFS_save"
  fi

  # Trim whitespace + filter unknown codes
  local code trimmed
  for code in "${raw[@]}"; do
    trimmed="${code// /}"
    [[ -z "$trimmed" ]] && continue
    if locale_name_for "$trimmed" >/dev/null 2>&1; then
      I18N_SELECTED+=("$trimmed")
    else
      echo "warning: unknown locale '$trimmed', skipping" >&2
    fi
  done
}

# 翻一个 (slug, locale)。成功写到 $slug/_debug/i18n/<locale>.json，失败追加 failures.log。
i18n_translate_one() {
  local slug="$1"
  local locale_code="$2"
  local slug_dir="$OUT_DIR/$slug"
  local i18n_dir="$slug_dir/_debug/i18n"
  mkdir -p "$i18n_dir"

  local out="$i18n_dir/$locale_code.json"
  local envelope="$i18n_dir/$locale_code.envelope.json"
  local err="$i18n_dir/$locale_code.stderr.log"
  local rec="$slug_dir/record.json"

  local locale_name
  locale_name=$(locale_name_for "$locale_code")

  # Extract only the translatable subset
  local source_json
  source_json=$(jq -c '{
    description: .description,
    members: (.members | map({memberPosition: .memberPosition, oneLiner: .oneLiner}))
  }' "$rec" 2>/dev/null)
  if [[ -z "$source_json" ]]; then
    printf '%s\tsource_extract_fail\n' "$locale_code" >> "$i18n_dir/failures.log"
    return 1
  fi

  local user_prompt
  user_prompt=$(jq -rn \
    --arg code "$locale_code" \
    --arg name "$locale_name" \
    --arg src "$source_json" \
    --rawfile tmpl "$I18N_TMPL_FILE" \
    '$tmpl
      | gsub("{{LOCALE_CODE}}"; $code)
      | gsub("{{LOCALE_NAME}}"; $name)
      | gsub("{{SOURCE_JSON}}"; $src)')

  set +e
  echo "$user_prompt" | "$CLAUDE_BIN" -p - \
    --model "$I18N_MODEL" \
    --output-format json \
    --json-schema "$I18N_SCHEMA_INLINE" \
    --max-turns 3 \
    --max-budget-usd "$MAX_BUDGET_I18N" \
    --permission-mode bypassPermissions \
    --system-prompt "$I18N_SYSTEM_PROMPT" \
    > "$envelope" 2> "$err"
  local exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    printf '%s\texit_%d\n' "$locale_code" "$exit_code" >> "$i18n_dir/failures.log"
    return 1
  fi

  set +e
  local parse_exit=1
  if jq -e '.structured_output | type == "object"' "$envelope" >/dev/null 2>&1; then
    jq '.structured_output' "$envelope" > "$out" 2>/dev/null
    parse_exit=$?
  elif jq -e '.structured_output | type == "string"' "$envelope" >/dev/null 2>&1; then
    jq -r '.structured_output' "$envelope" | jq . > "$out" 2>/dev/null
    parse_exit=$?
  fi
  set -e

  if [[ $parse_exit -ne 0 ]]; then
    printf '%s\tparse_fail\n' "$locale_code" >> "$i18n_dir/failures.log"
    rm -f "$out"
    return 1
  fi

  return 0
}

# 有界并发调度 (#slugs × #locales) 个翻译任务
i18n_dispatch() {
  local ok_slugs=("$@")
  local n_slugs=${#ok_slugs[@]}
  local n_locales=${#I18N_SELECTED[@]}
  local total=$((n_slugs * n_locales))
  [[ $total -eq 0 ]] && return 0

  echo ""
  echo "=== i18n translation (Haiku) ==="
  echo "Records:  $n_slugs"
  echo "Locales:  $n_locales (${I18N_SELECTED[*]})"
  echo "Jobs:     $total"
  echo "Parallel: $I18N_PARALLEL"
  echo "Model:    $I18N_MODEL"
  echo ""

  local pids=()
  local job_slug job_locale
  for job_slug in "${ok_slugs[@]}"; do
    for job_locale in "${I18N_SELECTED[@]}"; do
      i18n_translate_one "$job_slug" "$job_locale" &
      pids+=($!)
      if [[ ${#pids[@]} -ge $I18N_PARALLEL ]]; then
        wait "${pids[0]}" || true
        pids=("${pids[@]:1}")
      fi
    done
  done
  wait

  # Per-slug: update meta.json .i18n + generate record.full.json
  local slug slug_dir i18n_dir ok_count cost_sum_usd locales_ok locales_failed
  for slug in "${ok_slugs[@]}"; do
    slug_dir="$OUT_DIR/$slug"
    i18n_dir="$slug_dir/_debug/i18n"

    # Build the i18n map from per-locale json files
    local map='{}'
    local f loc
    shopt -s nullglob
    for f in "$i18n_dir"/*.json; do
      loc=$(basename "$f" .json)
      # skip envelope files and non-locale names
      [[ "$loc" == *.envelope ]] && continue
      [[ "$loc" == "failures" ]] && continue
      if locale_name_for "$loc" >/dev/null 2>&1; then
        map=$(echo "$map" | jq --arg k "$loc" --slurpfile v "$f" '. + {($k): $v[0]}')
      fi
    done
    shopt -u nullglob

    # Aggregate cost from envelopes (nullglob-safe)
    shopt -s nullglob
    local env_files=("$i18n_dir"/*.envelope.json)
    shopt -u nullglob
    if [[ ${#env_files[@]} -gt 0 ]]; then
      cost_sum_usd=$(jq -s 'map(.total_cost_usd // 0) | add // 0' "${env_files[@]}" 2>/dev/null || echo 0)
    else
      cost_sum_usd=0
    fi

    # Success/failure lists
    locales_ok=$(echo "$map" | jq -c 'keys')
    if [[ -f "$i18n_dir/failures.log" ]]; then
      locales_failed=$(awk -F'\t' '{print $1}' "$i18n_dir/failures.log" | sort -u | jq -R . | jq -cs .)
    else
      locales_failed='[]'
    fi

    # record.full.json 仅在至少有一个 locale 成功时生成(若全部失败则不落盘,避免产生空 i18n:{} 的误导性产物)
    if [[ "$map" != "{}" ]]; then
      jq --argjson i18n "$map" '. + {i18n: $i18n}' "$slug_dir/record.json" > "$slug_dir/record.full.json"
    fi

    # Patch meta.json .i18n
    jq --argjson locales_ok "$locales_ok" \
       --argjson locales_failed "$locales_failed" \
       --arg model "$I18N_MODEL" \
       --argjson cost "$cost_sum_usd" \
       '.i18n = {
          model: $model,
          locales_requested: ($locales_ok + $locales_failed | unique),
          locales_ok: $locales_ok,
          locales_failed: $locales_failed,
          cost_usd: $cost
        }' "$slug_dir/meta.json" > "$slug_dir/meta.json.tmp" \
      && mv "$slug_dir/meta.json.tmp" "$slug_dir/meta.json"

    ok_count=$(echo "$locales_ok" | jq 'length')
    echo "[$slug] i18n done: $ok_count/$n_locales ok"

    # 失败明细回显到 stderr,避免失败被 summary.tsv 的单列悄悄淹没
    if [[ -f "$i18n_dir/failures.log" ]]; then
      local n_fail
      n_fail=$(wc -l < "$i18n_dir/failures.log" | tr -d ' ')
      echo "[$slug] i18n: $n_fail locale(s) failed — see $i18n_dir/failures.log" >&2
      sed 's/^/        /' "$i18n_dir/failures.log" >&2
    fi
  done
}

# ── 导出 dashboard import 格式 ────────────────────────────────────────
# 把 record.json (源语言) + _debug/i18n/<locale>.json (翻译 sidecar) 合成
# {version, exportedAt, data:[...]} 格式,每个 locale 一条独立记录。
# 字段处理:strip sources、注入 locale、把翻译 merge 进 description + members[i].{memberPosition,oneLiner}。
export_dashboard_record() {
  local slug="$1"
  local slug_dir="$OUT_DIR/$slug"
  local rec="$slug_dir/record.json"
  local i18n_dir="$slug_dir/_debug/i18n"
  local out="$slug_dir/record.import.json"

  [[ -f "$rec" ]] || return 0

  # 源语言记录:strip sources,locale='en'
  local base_en
  base_en=$(jq 'del(.sources) | . + {locale: "en"}' "$rec")

  # 收集所有 locale 的记录
  local records_json
  records_json=$(echo "[$base_en]" | jq '.')

  shopt -s nullglob
  local f our_code dashboard_code merged
  for f in "$i18n_dir"/*.json; do
    our_code=$(basename "$f" .json)
    case "$our_code" in
      *.envelope|failures) continue ;;
    esac
    locale_name_for "$our_code" >/dev/null 2>&1 || continue

    dashboard_code=$(dashboard_locale_for "$our_code")

    # 合并翻译进 base record:替换 description + 逐 member 替换 memberPosition/oneLiner
    merged=$(jq \
      --slurpfile tr "$f" \
      --arg locale "$dashboard_code" \
      '. + {locale: $locale}
       | .description = ($tr[0].description // .description)
       | ($tr[0].members // []) as $tm
       | .members |= [range(0; length) as $i | .[$i] + ($tm[$i] // {})]' \
      <<< "$base_en")

    records_json=$(echo "$records_json" | jq --argjson r "$merged" '. + [$r]')
  done
  shopt -u nullglob

  # 包成 dashboard 信封
  jq -n \
    --argjson data "$records_json" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{version: "1.0", exportedAt: $ts, data: $data}' > "$out"
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
    i18n_dispatch "${OK_SLUGS[@]}"
  fi
fi

# ── 导出 dashboard import 格式 (record.import.json) ───────────────────
# 即使没翻译,也输出单条 'en' 记录,方便 dashboard 直接导入
if [[ "$DRY_RUN" -ne 1 ]] && [[ ${#OK_SLUGS[@]} -gt 0 ]]; then
  for _slug in "${OK_SLUGS[@]}"; do
    export_dashboard_record "$_slug"
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
