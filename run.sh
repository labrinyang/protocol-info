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

# Auto-load .env. Lookup order:
#   1. $SCRIPT_DIR/.env                  (standalone CLI use; never committed)
#   2. $HOME/.config/protocol-info/.env  (user config; works for plugin install
#                                         where $SCRIPT_DIR is read-only cache)
# Pre-set env vars take precedence (`set -a` only auto-exports new assignments;
# `source` does not overwrite vars already exported by the calling shell).
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

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
command -v "$CLAUDE_BIN" >/dev/null || { echo "claude CLI not found ($CLAUDE_BIN)" >&2; exit 127; }
command -v node          >/dev/null || { echo "node required" >&2; exit 127; }

exec node "$SCRIPT_DIR/framework/cli.mjs" "$@"
