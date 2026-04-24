#!/bin/bash
#
# Run unit tests for translate.mjs.
# Integration tests (real claude -p calls) are skipped by default.
#
# Usage:
#   ./test/run-tests.sh              # unit tests only
#   INTEGRATION=1 ./test/run-tests.sh  # unit + integration tests

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

passed=0
failed=0

for test_file in "$SCRIPT_DIR"/test-*.mjs; do
  name=$(basename "$test_file" .mjs)
  printf "%-35s " "$name"
  if node "$test_file" 2>&1; then
    ((passed++))
  else
    ((failed++))
  fi
done

echo ""
echo "=== Results: $passed passed, $failed failed ==="
exit $((failed > 0 ? 1 : 0))
