#!/usr/bin/env bash
# Fail when commits exist after the last recorded review.
#
#   bash scripts/review-gate.sh            # check
#   bash scripts/review-gate.sh --update   # record HEAD as reviewed
#
# The file is per branch: after a review, update it and commit the new SHA.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SHA_FILE="$ROOT/REVIEWED_SHA"

if [ "${1:-}" = "--update" ]; then
  git rev-parse HEAD > "$SHA_FILE"
  echo "review-gate: recorded $(cat "$SHA_FILE")"
  exit 0
fi

if [ ! -f "$SHA_FILE" ]; then
  echo "review-gate: no REVIEWED_SHA; record one with --update after a review" >&2
  exit 1
fi

REVIEWED="$(tr -d '[:space:]' < "$SHA_FILE")"
if ! git rev-parse --verify --quiet "$REVIEWED" >/dev/null; then
  echo "review-gate: reviewed SHA $REVIEWED is not in this history" >&2
  exit 1
fi

# The recording file is the one thing this gate must not count as a change.
if ! git diff --quiet "$REVIEWED"...HEAD -- . ':(exclude)REVIEWED_SHA'; then
  echo "review-gate: unreviewed changes since $REVIEWED:" >&2
  git log --oneline "$REVIEWED"..HEAD >&2
  exit 1
fi

echo "review-gate: HEAD matches the reviewed $REVIEWED"
