#!/bin/bash
#
# 通过 claude -p 无头模式批量抓取 EarnProtocolInfo 记录。
#
# 双轮管线（设置 ROOTDATA_API_KEY 时）：
#   Round 1  Claude 网页抓取
#   API      preprocess-rootdata.mjs 与 Round 1 并行运行
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
#
# 环境变量：
#   CLAUDE_BIN          claude CLI 路径（默认: "claude"）
#   ROOTDATA_API_KEY    RootData API 密钥（可选；启用 Round 2）
#
# 输出（每次运行生成带时间戳的子目录）：
#   out/<ts>/<slug>.json            校验通过的 protocol-info 记录
#   out/<ts>/<slug>.raw.json        Round 1 claude 原始信封
#   out/<ts>/<slug>.r2.raw.json     Round 2 claude 原始信封（如适用）
#   out/<ts>/<slug>.stderr.log      抓取 stderr
#   out/<ts>/<slug>.sidecar.json    对账元数据（如 Round 2 执行）
#   out/<ts>/summary.tsv            结果汇总表

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-load .env if present (never committed — see .gitignore)
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi
SCHEMA_FILE="$SCRIPT_DIR/schema/earn-protocol-info.schema.json"
SYSTEM_PROMPT_FILE="$SCRIPT_DIR/prompts/system.md"
USER_TMPL_FILE="$SCRIPT_DIR/prompts/user.md.tmpl"
RECONCILE_TMPL_FILE="$SCRIPT_DIR/prompts/reconcile.md.tmpl"
PREPROCESS_SCRIPT="$SCRIPT_DIR/preprocess-rootdata.mjs"
TRANSLATE_SCRIPT="$SCRIPT_DIR/translate.mjs"
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$SCRIPT_DIR/out/$RUN_TS"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MODEL=""
MAX_TURNS=40
MAX_TURNS_R2=10
MAX_BUDGET_USD="2.00"
MAX_BUDGET_R2="0.50"
DRY_RUN=0
TRANSLATE="${TRANSLATE:-0}"
TRANSLATE_CONCURRENCY="${TRANSLATE_CONCURRENCY:-6}"
TRANSLATE_LOCALES="${TRANSLATE_LOCALES:-}"

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
  if [[ -z "$_type" ]]; then
    echo "错误: --type 为必填参数" >&2; exit 1
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
    --dry-run)      DRY_RUN=1; shift ;;
    --translate)    TRANSLATE=1; shift ;;
    --translate-concurrency) TRANSLATE_CONCURRENCY="$2"; shift 2 ;;
    --translate-locales)     TRANSLATE_LOCALES="$2"; shift 2 ;;
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

command -v "$CLAUDE_BIN" >/dev/null || { echo "claude CLI not found ($CLAUDE_BIN)" >&2; exit 127; }
command -v jq           >/dev/null || { echo "jq required" >&2; exit 127; }
command -v node         >/dev/null || { echo "node required" >&2; exit 127; }

ROOTDATA_ENABLED=0
if [[ -n "${ROOTDATA_API_KEY:-}" ]]; then
  ROOTDATA_ENABLED=1
fi

LOG_DIR="$OUT_DIR/.logs"
mkdir -p "$OUT_DIR" "$LOG_DIR"
printf "slug\tstatus\tmembers\tfunding\taudits\tschema\tsource\tapi_status\n" > "$LOG_DIR/summary.tsv"

MODEL_FLAG=()
[[ -n "$MODEL" ]] && MODEL_FLAG=(--model "$MODEL")

SELECTED_JSON=$(printf '%s\n' "${PROVIDERS[@]}" | jq -s '.')
TOTAL=$(echo "$SELECTED_JSON" | jq 'length')

echo "=== Protocol-info crawl ==="
echo "Providers:   $TOTAL"
echo "Model:       ${MODEL:-default}"
echo "Max turns:   $MAX_TURNS"
echo "Max budget:  \$${MAX_BUDGET_USD} / provider"
echo "RootData:    $(if [[ $ROOTDATA_ENABLED -eq 1 ]]; then echo "enabled (Round 2)"; else echo "disabled (single-round)"; fi)"
echo "Translate:   $(if [[ $TRANSLATE -eq 1 ]]; then echo "enabled (concurrency=$TRANSLATE_CONCURRENCY${TRANSLATE_LOCALES:+, locales=$TRANSLATE_LOCALES})"; else echo "disabled"; fi)"
echo "Out dir:     $OUT_DIR"
echo ""

SCHEMA_INLINE=$(cat "$SCHEMA_FILE")
SYSTEM_PROMPT=$(cat "$SYSTEM_PROMPT_FILE")

INDEX=0
while IFS= read -r provider_json; do
  INDEX=$((INDEX + 1))
  slug=$(echo "$provider_json"     | jq -r '.slug')
  provider=$(echo "$provider_json" | jq -r '.provider')
  display=$(echo "$provider_json"  | jq -r '.displayName')
  type=$(echo "$provider_json"     | jq -r '.type')
  hints=$(echo "$provider_json"    | jq -r '.hints // ""')
  rootdata_id=$(echo "$provider_json" | jq -r '.rootdataId // empty')

  echo "[$INDEX/$TOTAL] $slug ($type)"

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
    continue
  fi

  raw_file="$LOG_DIR/$slug.raw.json"
  err_file="$LOG_DIR/$slug.stderr.log"
  out_file="$OUT_DIR/$slug.json"
  api_packet="$LOG_DIR/$slug.rootdata-packet.json"
  r2_raw="$LOG_DIR/$slug.r2.raw.json"
  sidecar_file="$LOG_DIR/$slug.sidecar.json"

  # ── Phase 1: Parallel execution (Claude Round 1 + RootData API) ──

  echo "$user_prompt" | "$CLAUDE_BIN" -p - \
    --output-format json \
    --json-schema "$SCHEMA_INLINE" \
    --max-turns "$MAX_TURNS" \
    --max-budget-usd "$MAX_BUDGET_USD" \
    --permission-mode bypassPermissions \
    --allowed-tools "WebFetch,WebSearch" \
    --system-prompt "$SYSTEM_PROMPT" \
    ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} \
    > "$raw_file" 2> "$err_file" &
  pid_claude=$!

  api_exit=1
  if [[ $ROOTDATA_ENABLED -eq 1 ]]; then
    rootdata_id_flag=()
    if [[ -n "$rootdata_id" ]]; then
      rootdata_id_flag=(--rootdata-id "$rootdata_id")
    fi
    node "$PREPROCESS_SCRIPT" \
      --slug "$slug" \
      --display-name "$display" \
      ${rootdata_id_flag[@]+"${rootdata_id_flag[@]}"} \
      --output "$api_packet" \
      2> "$err_file.api" &
    pid_api=$!
  fi

  # Wait for both processes
  set +e
  wait $pid_claude; r1_exit=$?
  if [[ $ROOTDATA_ENABLED -eq 1 ]]; then
    wait $pid_api; api_exit=$?
  fi
  set -e

  # ── Phase 2: Extract Round 1 result ──

  if [[ $r1_exit -ne 0 ]]; then
    echo "  -> CRAWL_FAIL (exit $r1_exit); see $err_file"
    printf "%s\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t$(if [[ $ROOTDATA_ENABLED -eq 1 ]]; then echo "exit_$api_exit"; else echo "disabled"; fi)\n" "$slug" >> "$LOG_DIR/summary.tsv"
    continue
  fi

  set +e
  if jq -e '.structured_output | type == "object"' "$raw_file" >/dev/null 2>&1; then
    jq '.structured_output' "$raw_file" > "$out_file" 2> "$err_file.parse"
    parse_exit=$?
  elif jq -e '.structured_output | type == "string"' "$raw_file" >/dev/null 2>&1; then
    jq -r '.structured_output' "$raw_file" | jq . > "$out_file" 2> "$err_file.parse"
    parse_exit=$?
  else
    payload=$(jq -r '.result // empty' "$raw_file")
    if [[ -z "$payload" ]]; then
      echo "  -> CRAWL_FAIL (no structured_output, empty .result); see $raw_file"
      printf "%s\tCRAWL_FAIL\t-\t-\t-\t-\tr1\t-\n" "$slug" >> "$LOG_DIR/summary.tsv"
      set -e
      continue
    fi
    echo "$payload" | node "$SCRIPT_DIR/extract-json.mjs" | jq . > "$out_file" 2> "$err_file.parse"
    parse_exit=$?
  fi
  set -e

  if [[ $parse_exit -ne 0 ]]; then
    echo "  -> PARSE_FAIL (no JSON object recoverable); see $err_file.parse"
    printf "%s\tPARSE_FAIL\t-\t-\t-\t-\tr1\t-\n" "$slug" >> "$LOG_DIR/summary.tsv"
    continue
  fi

  SESSION_ID=$(jq -r '.session_id // empty' "$raw_file")
  r1_cost=$(jq -r '.total_cost_usd // 0' "$raw_file")
  final_source="r1"
  api_status="disabled"
  r2_cost="0"
  overrides_applied=""
  member_candidates_fed=0
  funding_severity="none"

  # ── Phase 3: Round 2 reconciliation (only if API succeeded + valid session) ──

  if [[ -z "$SESSION_ID" ]]; then
    echo "  -> No session_id in Round 1 response, skipping Round 2"
  elif [[ $ROOTDATA_ENABLED -eq 1 && $api_exit -eq 0 && -f "$api_packet" ]]; then
    api_status="ok"
    echo "  -> API packet ready, building Round 2 prompt..."

    # Read API packet sections
    establishment_value=$(jq -r '.anchors.establishment.value // "unknown"' "$api_packet")
    member_candidates_json=$(jq -c '.member_candidates' "$api_packet")
    member_candidates_fed=$(jq '.member_candidates | length' "$api_packet")

    # Compute investor diff (Step B from §3.4.3)
    # Extract Round 1 investors (normalized: lowercase, strip common suffixes)
    r1_investors=$(jq -r '[.fundingRounds[]?.investors[]?] | map(ascii_downcase | gsub("[[:space:]]+(capital|ventures|labs|fund|partners|investments|group|network)[[:space:]]*$"; "")) | unique | .[]' "$out_file" 2>/dev/null || echo "")
    # Use pre-normalized investor names from the API packet (normalized in JS)
    api_org_investors=$(jq -r '.api_funding.investors_orgs_normalized[]?' "$api_packet" 2>/dev/null || echo "")

    # Compute missing org investors (full-line match to avoid substring false positives)
    missing_orgs=()
    while IFS= read -r api_inv; do
      [[ -z "$api_inv" ]] && continue
      if ! echo "$r1_investors" | grep -qxiF "$api_inv"; then
        missing_orgs+=("$api_inv")
      fi
    done <<< "$api_org_investors"

    missing_org_count=${#missing_orgs[@]}
    api_people=$(jq -r '.api_funding.investors_people // []' "$api_packet")
    api_total_funding=$(jq -r '.api_funding.total_funding // "unknown"' "$api_packet")

    # Severity classification
    if [[ $missing_org_count -gt 5 ]]; then
      funding_severity="high"
    elif [[ $missing_org_count -ge 2 ]]; then
      funding_severity="medium"
    else
      funding_severity="low"
    fi

    # Build funding discrepancy JSON
    funding_discrepancy=$(jq -n \
      --arg severity "$funding_severity" \
      --arg total "$api_total_funding" \
      --argjson missing "$(if [[ ${#missing_orgs[@]} -gt 0 ]]; then printf '%s\n' "${missing_orgs[@]}" | jq -R . | jq -s .; else echo '[]'; fi)" \
      --argjson people "$api_people" \
      '{
        severity: $severity,
        api_total_funding: $total,
        missing_org_investors: $missing,
        api_angel_investors: $people
      }')

    # Render reconcile.md.tmpl
    r2_prompt=$(jq -rn \
      --arg est "$establishment_value" \
      --arg members "$member_candidates_json" \
      --arg funding "$funding_discrepancy" \
      --rawfile tmpl "$RECONCILE_TMPL_FILE" \
      '$tmpl
        | gsub("{{ESTABLISHMENT_VALUE}}"; $est)
        | gsub("{{MEMBER_CANDIDATES_JSON}}"; $members)
        | gsub("{{FUNDING_DISCREPANCY_JSON}}"; $funding)')

    # Run Round 2
    echo "  -> Round 2: resuming session $SESSION_ID..."
    set +e
    echo "$r2_prompt" | "$CLAUDE_BIN" -p - \
      --resume "$SESSION_ID" \
      --output-format json \
      --json-schema "$SCHEMA_INLINE" \
      --max-turns "$MAX_TURNS_R2" \
      --max-budget-usd "$MAX_BUDGET_R2" \
      --permission-mode bypassPermissions \
      --allowed-tools "WebFetch,WebSearch" \
      ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} \
      > "$r2_raw" 2> "$err_file.r2"
    r2_exit=$?
    set -e

    if [[ $r2_exit -eq 0 ]]; then
      # Extract Round 2 structured output to a temp file (preserve Round 1 output on failure)
      r2_tmp="$out_file.r2.tmp"
      r2_parsed=0
      set +e
      if jq -e '.structured_output | type == "object"' "$r2_raw" >/dev/null 2>&1; then
        jq '.structured_output' "$r2_raw" > "$r2_tmp" 2>/dev/null
        r2_parsed=$?
      elif jq -e '.structured_output | type == "string"' "$r2_raw" >/dev/null 2>&1; then
        jq -r '.structured_output' "$r2_raw" | jq . > "$r2_tmp" 2>/dev/null
        r2_parsed=$?
      else
        r2_result=$(jq -r '.result // empty' "$r2_raw")
        if [[ -n "$r2_result" ]]; then
          echo "$r2_result" | node "$SCRIPT_DIR/extract-json.mjs" | jq . > "$r2_tmp" 2>/dev/null
          r2_parsed=$?
        else
          r2_parsed=1
        fi
      fi
      set -e

      if [[ $r2_parsed -eq 0 ]]; then
        mv "$r2_tmp" "$out_file"
        final_source="r2"
        r2_cost=$(jq -r '.total_cost_usd // 0' "$r2_raw")
        echo "  -> Round 2 OK (\$$r2_cost)"
      else
        rm -f "$r2_tmp"
        echo "  -> Round 2 PARSE_FAIL — falling back to Round 1 output"
      fi
    else
      echo "  -> Round 2 CRAWL_FAIL (exit $r2_exit) — using Round 1 output"
    fi

    # Apply validated_overrides via jq patch (AFTER Round 2)
    override_website=$(jq -r '.validated_overrides.providerWebsite // empty' "$api_packet")
    override_xlink=$(jq -r '.validated_overrides.providerXLink // empty' "$api_packet")
    overrides_list=()

    if [[ -n "$override_website" ]]; then
      jq --arg w "$override_website" '.providerWebsite=$w' "$out_file" > "$out_file.tmp" && mv "$out_file.tmp" "$out_file"
      overrides_list+=("providerWebsite")
    fi
    if [[ -n "$override_xlink" ]]; then
      jq --arg x "$override_xlink" '.providerXLink=$x' "$out_file" > "$out_file.tmp" && mv "$out_file.tmp" "$out_file"
      overrides_list+=("providerXLink")
    fi
    overrides_applied=$(printf '%s,' "${overrides_list[@]}" 2>/dev/null | sed 's/,$//')

    # Write sidecar
    r1_turns=$(jq -r '.num_turns // 0' "$raw_file")
    r2_turns=$(jq -r '.num_turns // 0' "$r2_raw" 2>/dev/null || echo "0")
    jq -n \
      --argjson r1_cost "$r1_cost" \
      --argjson r2_cost "$r2_cost" \
      --argjson r1_turns "$r1_turns" \
      --argjson r2_turns "${r2_turns:-0}" \
      --argjson members_fed "$member_candidates_fed" \
      --arg severity "$funding_severity" \
      --arg overrides "$overrides_applied" \
      '{
        round1_cost_usd: $r1_cost,
        round2_cost_usd: $r2_cost,
        total_turns: ($r1_turns + $r2_turns),
        api_packet_used: true,
        overrides_applied: ($overrides | split(",") | map(select(. != ""))),
        member_candidates_fed: $members_fed,
        funding_discrepancy_severity: $severity
      }' > "$sidecar_file"

  elif [[ $ROOTDATA_ENABLED -eq 1 && $api_exit -ne 0 ]]; then
    api_status="exit_$api_exit"
    echo "  -> API_SKIP (exit $api_exit); using Round 1 output only"
  fi

  # ── Phase 4: Post-processing (same as original) ──

  if jq -e '.audits.items | type == "array"' "$out_file" >/dev/null 2>&1; then
    today=$(date -u +%Y-%m-%d)
    jq --arg today "$today" '.audits.lastScannedAt = $today' "$out_file" \
      > "$out_file.tmp" && mv "$out_file.tmp" "$out_file"
  fi

  # Validate
  set +e
  node "$SCRIPT_DIR/validate.mjs" "$out_file" > "$err_file.schema" 2>&1
  schema_exit=$?
  set -e

  members=$(jq -r '.members | length // 0' "$out_file" 2>/dev/null || echo "-")
  funding=$(jq -r '.fundingRounds | length // 0' "$out_file" 2>/dev/null || echo "-")
  audits_n=$(jq -r '.audits.items | length // 0' "$out_file" 2>/dev/null || echo "-")

  if [[ $schema_exit -eq 0 ]]; then
    echo "  -> OK  members=$members funding=$funding audits=$audits_n source=$final_source"
    printf "%s\tOK\t%s\t%s\t%s\tpass\t%s\t%s\n" "$slug" "$members" "$funding" "$audits_n" "$final_source" "$api_status" >> "$LOG_DIR/summary.tsv"

    # ── Phase 5: Translation (optional) ──
    if [[ "${TRANSLATE}" -eq 1 ]]; then
      echo "  -> Translating to ${TRANSLATE_LOCALES:-all locales}..."
      translate_args=("$out_file" --concurrency "$TRANSLATE_CONCURRENCY")
      [[ -n "$TRANSLATE_LOCALES" ]] && translate_args+=(--locales "$TRANSLATE_LOCALES")
      set +e
      node "$TRANSLATE_SCRIPT" "${translate_args[@]}" 2> "$err_file.translate"
      translate_exit=$?
      set -e
      if [[ $translate_exit -ne 0 ]]; then
        echo "  -> Translation PARTIAL_FAIL (see $err_file.translate)"
      fi
    fi
  else
    echo "  -> SCHEMA_FAIL  members=$members funding=$funding audits=$audits_n source=$final_source"
    sed 's/^/        /' "$err_file.schema"
    printf "%s\tSCHEMA_FAIL\t%s\t%s\t%s\tfail\t%s\t%s\n" "$slug" "$members" "$funding" "$audits_n" "$final_source" "$api_status" >> "$LOG_DIR/summary.tsv"
  fi
done < <(echo "$SELECTED_JSON" | jq -c '.[]')

echo ""
echo "=== Summary ==="
column -t -s "$(printf '\t')" "$LOG_DIR/summary.tsv"
echo ""
echo "Next: review $OUT_DIR/*.json, edit by hand as needed, then import via dashboard CRUD."
