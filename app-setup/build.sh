#!/usr/bin/env bash
# Compile and prepare a Relay solution.
# Usage: build.sh [SOLUTION_DIR]   (default: $SOLUTION_DIR or ./solution)
set -euo pipefail
SOLUTION_DIR="${1:-${SOLUTION_DIR:-solution}}"
cd "$SOLUTION_DIR"
if [ ! -f package.json ]; then
  echo "build.sh: no package.json in $SOLUTION_DIR" >&2
  exit 1
fi
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error
else
  npm install --no-audit --no-fund --loglevel=error
fi
npm run build --if-present --silent
echo "build.sh: built $SOLUTION_DIR"
