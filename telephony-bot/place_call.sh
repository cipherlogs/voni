#!/usr/bin/env bash
# Compatibility wrapper for the bridge-config-aware caller.
# Usage: ./place_call.sh +447512345678 --yes
set -euo pipefail
exec "$(dirname "$0")/.venv/bin/python" "$(dirname "$0")/place_call.py" "$@"
