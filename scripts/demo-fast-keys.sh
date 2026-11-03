#!/usr/bin/env bash
#
# Reports whether the demo fast contract's vendor keys are present, by name.
#
# The pull-request workflow may name a vendor key only as a `secrets.`/`vars.`
# expression (voice-pipeline/test_nightly_smoke.py enforces that no key is ever
# used outside one), so the presence check lives here and ci.yml wires only the
# references in. No key value is read into a message, printed, or written.
#
#   bash scripts/demo-fast-keys.sh
#
# Writes `present` and `missing` to $GITHUB_OUTPUT when it is set (CI), and
# prints one named line either way.
set -euo pipefail

missing=""
for name in META_API_KEY ASSEMBLYAI_API_KEY VOICE_PIPELINE_ENVELOPE_SECRET; do
  if [ -z "${!name:-}" ]; then
    if [ -n "$missing" ]; then
      missing="$missing, "
    fi
    missing="${missing}${name}"
  fi
done

if [ -n "$missing" ]; then
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "present=false"
      echo "missing=$missing"
    } >> "$GITHUB_OUTPUT"
  fi
  echo "SKIPPED: the demo fast contract made no call — missing vendor keys: $missing."
  exit 0
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "present=true"
    echo "missing="
  } >> "$GITHUB_OUTPUT"
fi
echo "vendor keys present: the demo fast contract will run."
