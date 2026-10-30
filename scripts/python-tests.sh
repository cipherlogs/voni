#!/usr/bin/env bash
# Run the Python suites and fail on an unexpected skip.
#
# `unittest` exits 0 with "OK (skipped=N)". A skip is an unfinished test, not a
# pass, so this wrapper fails unless the skip is explicitly allowed.
#
#   PYTHON=telephony-bot/.venv/bin/python bash scripts/python-tests.sh
#   ALLOW_SKIPS=1 ...                       # local escape hatch, never CI
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python}"
# telephony-bot/server.py reads this at import time; no test dials it.
export PUBLIC_HOST="${PUBLIC_HOST:-ci.invalid}"
cd "$ROOT"

run() {
  local name="$1"
  shift
  local output
  if ! output="$("$@" 2>&1)"; then
    printf '%s\n' "$output"
    echo "python-tests: $name FAILED"
    exit 1
  fi
  printf '%s\n' "$output" | tail -5
  if printf '%s\n' "$output" | grep -qE 'skipped=[1-9]'; then
    if [ "${ALLOW_SKIPS:-0}" = "1" ]; then
      echo "python-tests: $name has skips (allowed by ALLOW_SKIPS=1)"
      return 0
    fi
    printf '%s\n' "$output" | grep -i 'skip'
    echo "python-tests: $name has an unexpected skip; fix it or set ALLOW_SKIPS=1"
    exit 1
  fi
}

run "bridge" "$PYTHON" -m unittest discover -s telephony-bot -p 'test_*.py'
run "pipeline" "$PYTHON" -m unittest discover -s voice-pipeline -p 'test_*.py'
