#!/bin/bash
#
# protocol-info crawl: thin bash shim around framework/cli.mjs.
# Auto-loads .env so ROOTDATA_API_KEY etc. are available, then exec's node.
#
# Run-time help:
#   ./run.sh --help     →  delegates to: node framework/cli.mjs --help
#
# Inputs: see framework/cli.mjs for the full flag set.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-load .env. Lookup order, highest priority first:
#   1. already-exported shell env
#   2. $HOME/.config/protocol-info/.env  (user config; survives plugin updates)
#   3. $SCRIPT_DIR/.env                  (standalone CLI use; never committed)
#
# Only fill missing variables from .env files. This mirrors framework/cli.mjs
# and prevents a bundled/plugin-local .env from overriding user config.
load_env_file_missing() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue

    if [[ "$line" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      val="${BASH_REMATCH[3]}"
      val="${val#"${val%%[![:space:]]*}"}"
      val="${val%"${val##*[![:space:]]}"}"
      if [[ ( "${val:0:1}" == '"' && "${val: -1}" == '"' ) || ( "${val:0:1}" == "'" && "${val: -1}" == "'" ) ]]; then
        val="${val:1:${#val}-2}"
      fi
      [[ -z "$val" ]] && continue
      if [[ -z "${!key+x}" ]]; then
        export "$key=$val"
        export "PROTOCOL_INFO_ENV_ORIGIN_${key}=$env_file"
      fi
    fi
  done < "$env_file"
}

load_env_file_missing "$HOME/.config/protocol-info/.env"
load_env_file_missing "$SCRIPT_DIR/.env"
unset -f load_env_file_missing

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
command -v node          >/dev/null || { echo "node required" >&2; exit 127; }

if [[ "${1:-}" == "browse" ]]; then
  shift
  exec node "$SCRIPT_DIR/framework/out-browser.mjs" "$@"
fi

command -v "$CLAUDE_BIN" >/dev/null || { echo "claude CLI not found ($CLAUDE_BIN)" >&2; exit 127; }

exec node "$SCRIPT_DIR/framework/cli.mjs" "$@"
