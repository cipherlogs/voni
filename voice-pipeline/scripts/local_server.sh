#!/bin/sh
# Dev-only launcher: loads voni/.dev.vars into the environment (same values
# `next dev` picks up) and starts the cascade service on 8766.
# Production runs the service with real host env instead — never this file.
set -a
# shellcheck disable=SC1091
. "$(dirname "$0")/../../voni/.dev.vars"
set +a
exec "$(dirname "$0")/../../telephony-bot/.venv/bin/python" "$(dirname "$0")/../server.py"
