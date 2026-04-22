#!/bin/bash
#
# Batch-crawl EarnProtocolInfo records via `claude -p` headless mode.
#
# Usage:
#   ./run.sh                              # crawl all providers in providers.json
#   ./run.sh pendle morpho                # crawl a subset (by slug)
#   ./run.sh --model sonnet pendle        # pin a specific model
#   ./run.sh --max-turns 40               # override turn budget
#   ./run.sh --max-budget 2.00 pendle     # cap API spend per provider (USD)
#   ./run.sh --dry-run pendle             # print the rendered prompt and exit
#
# Environment:
#   CLAUDE_BIN   Path to claude CLI (default: "claude")
#
# Output (each run gets a timestamped subdirectory):
#   out/<YYYYMMDDTHHMMSSZ>/<slug>.json       Validated protocol-info record
#   out/<YYYYMMDDTHHMMSSZ>/<slug>.raw.json   Raw claude -p envelope (debugging)
#   out/<YYYYMMDDTHHMMSSZ>/<slug>.stderr.log Crawl stderr
#   out/<YYYYMMDDTHHMMSSZ>/summary.tsv       slug | status | members | funding | audits | schema

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROVIDERS_FILE="$SCRIPT_DIR/providers.json"
SCHEMA_FILE="$SCRIPT_DIR/schema/earn-protocol-info.schema.json"
SYSTEM_PROMPT_FILE="$SCRIPT_DIR/prompts/system.md"
USER_TMPL_FILE="$SCRIPT_DIR/prompts/user.md.tmpl"
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$SCRIPT_DIR/out/$RUN_TS"
SUMMARY_FILE="$OUT_DIR/summary.tsv"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MODEL=""
MAX_TURNS=40
MAX_BUDGET_USD="2.00"
DRY_RUN=0
SELECTED=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)      MODEL="$2"; shift 2 ;;
    --max-turns)  MAX_TURNS="$2"; shift 2 ;;
    --max-budget) MAX_BUDGET_USD="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)
      grep -E '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "unknown flag: $1" >&2; exit 1 ;;
    *)
      SELECTED+=("$1"); shift ;;
  esac
done

command -v "$CLAUDE_BIN" >/dev/null || { echo "claude CLI not found ($CLAUDE_BIN)" >&2; exit 127; }
command -v jq           >/dev/null || { echo "jq required" >&2; exit 127; }
command -v node         >/dev/null || { echo "node required" >&2; exit 127; }

mkdir -p "$OUT_DIR"
printf "slug\tstatus\tmembers\tfunding\taudits\tschema\n" > "$SUMMARY_FILE"

MODEL_FLAG=()
[[ -n "$MODEL" ]] && MODEL_FLAG=(--model "$MODEL")

# Select providers
if [[ ${#SELECTED[@]} -eq 0 ]]; then
  SELECTED_JSON=$(jq '.providers' "$PROVIDERS_FILE")
else
  # Filter providers.json by requested slugs
  # shellcheck disable=SC2016
  SELECTED_JSON=$(jq --argjson want "$(printf '%s\n' "${SELECTED[@]}" | jq -R . | jq -s .)" \
    '.providers | map(select(.slug as $s | $want | index($s)))' "$PROVIDERS_FILE")
  found=$(echo "$SELECTED_JSON" | jq 'length')
  if [[ "$found" -eq 0 ]]; then
    echo "none of the requested slugs matched providers.json" >&2
    exit 1
  fi
fi

TOTAL=$(echo "$SELECTED_JSON" | jq 'length')
echo "=== Protocol-info crawl ==="
echo "Providers:   $TOTAL"
echo "Model:       ${MODEL:-default}"
echo "Max turns:   $MAX_TURNS"
echo "Max budget:  \$${MAX_BUDGET_USD} / provider"
echo "Out dir:     $OUT_DIR"
echo ""

SCHEMA_INLINE=$(cat "$SCHEMA_FILE")
SYSTEM_PROMPT=$(cat "$SYSTEM_PROMPT_FILE")

INDEX=0
echo "$SELECTED_JSON" | jq -c '.[]' | while IFS= read -r provider_json; do
  INDEX=$((INDEX + 1))
  slug=$(echo "$provider_json"     | jq -r '.slug')
  provider=$(echo "$provider_json" | jq -r '.provider')
  display=$(echo "$provider_json"  | jq -r '.displayName')
  type=$(echo "$provider_json"     | jq -r '.type')
  hints=$(echo "$provider_json"    | jq -r '.hints // ""')

  echo "[$INDEX/$TOTAL] $slug ($type)"

  # Render user prompt template (jq -r for raw text output, not JSON-encoded)
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

  raw_file="$OUT_DIR/$slug.raw.json"
  err_file="$OUT_DIR/$slug.stderr.log"
  out_file="$OUT_DIR/$slug.json"

  set +e
  echo "$user_prompt" | "$CLAUDE_BIN" -p - \
    --output-format json \
    --json-schema "$SCHEMA_INLINE" \
    --max-turns "$MAX_TURNS" \
    --max-budget-usd "$MAX_BUDGET_USD" \
    --permission-mode bypassPermissions \
    --allowed-tools "WebFetch,WebSearch" \
    --system-prompt "$SYSTEM_PROMPT" \
    ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} \
    > "$raw_file" 2> "$err_file"
  exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "  -> CRAWL_FAIL (exit $exit_code); see $err_file"
    printf "%s\tCRAWL_FAIL\t-\t-\t-\t-\n" "$slug" >> "$SUMMARY_FILE"
    continue
  fi

  # Prefer .structured_output (from --json-schema). Fallback to .result + extract-json.mjs
  # for older CLIs or when the model violates the schema and the CLI degrades to prose.
  set +e
  if jq -e '.structured_output | type == "object"' "$raw_file" >/dev/null 2>&1; then
    jq '.structured_output' "$raw_file" > "$out_file" 2> "$err_file.parse"
    parse_exit=$?
  elif jq -e '.structured_output | type == "string"' "$raw_file" >/dev/null 2>&1; then
    # Some CLI builds JSON-encode structured_output as a string — unwrap it
    jq -r '.structured_output' "$raw_file" | jq . > "$out_file" 2> "$err_file.parse"
    parse_exit=$?
  else
    payload=$(jq -r '.result // empty' "$raw_file")
    if [[ -z "$payload" ]]; then
      echo "  -> CRAWL_FAIL (no structured_output, empty .result); see $raw_file"
      printf "%s\tCRAWL_FAIL\t-\t-\t-\t-\n" "$slug" >> "$SUMMARY_FILE"
      set -e
      continue
    fi
    echo "$payload" | node "$SCRIPT_DIR/extract-json.mjs" | jq . > "$out_file" 2> "$err_file.parse"
    parse_exit=$?
  fi
  set -e

  if [[ $parse_exit -ne 0 ]]; then
    echo "  -> PARSE_FAIL (no JSON object recoverable); see $err_file.parse"
    printf "%s\tPARSE_FAIL\t-\t-\t-\t-\n" "$slug" >> "$SUMMARY_FILE"
    continue
  fi

  # Normalize audits.lastScannedAt deterministically (Claude's context date can drift).
  # Only touch it when .audits.items is a real array — avoids crashing on malformed output
  # that will fail schema validation below anyway.
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
    echo "  -> OK  members=$members funding=$funding audits=$audits_n"
    printf "%s\tOK\t%s\t%s\t%s\tpass\n" "$slug" "$members" "$funding" "$audits_n" >> "$SUMMARY_FILE"
  else
    echo "  -> SCHEMA_FAIL  members=$members funding=$funding audits=$audits_n"
    cat "$err_file.schema" | sed 's/^/        /'
    printf "%s\tSCHEMA_FAIL\t%s\t%s\t%s\tfail\n" "$slug" "$members" "$funding" "$audits_n" >> "$SUMMARY_FILE"
  fi
done

echo ""
echo "=== Summary ==="
column -t -s "$(printf '\t')" "$SUMMARY_FILE"
echo ""
echo "Next: review $OUT_DIR/*.json, edit by hand as needed, then import via dashboard CRUD."
