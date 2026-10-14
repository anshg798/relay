#!/usr/bin/env bash
# Start a built Relay solution in the foreground.
# Env: SOLUTION_DIR (default ./solution), PORT (default 8080), DATA_DIR (default $SOLUTION_DIR/data)
set -euo pipefail
SOLUTION_DIR="${1:-${SOLUTION_DIR:-solution}}"
SOLUTION_DIR="$(cd "$SOLUTION_DIR" && pwd)"
export PORT="${PORT:-8080}"
export DATA_DIR="${DATA_DIR:-$SOLUTION_DIR/data}"
mkdir -p "$DATA_DIR"
cd "$SOLUTION_DIR"
exec npm start --silent
