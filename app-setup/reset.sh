#!/usr/bin/env bash
# Remove generated state and build artifacts so the next build starts clean.
set -euo pipefail
SOLUTION_DIR="${1:-${SOLUTION_DIR:-solution}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -d "$SOLUTION_DIR" ]; then
  rm -rf "$SOLUTION_DIR/dist" "$SOLUTION_DIR/data" "$SOLUTION_DIR/node_modules"
fi
rm -rf "$ROOT/.eval-tmp"
echo "reset.sh: cleaned $SOLUTION_DIR"
