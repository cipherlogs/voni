#!/usr/bin/env bash
# Create a linked worktree on a disk-backed root, then prepare it.
#
#   bash scripts/worktree-create.sh <name> [branch] [base]
#
# The root defaults to a sibling of the repo (not /tmp, which is often a small
# tmpfs). Override with WORKTREE_ROOT. Refuses to start without 2 GB free.
set -euo pipefail

NAME="${1:?usage: worktree-create.sh <name> [branch] [base]}"
BRANCH="${2:-ticket/$NAME}"
BASE="${3:-HEAD}"

REPO="$(git rev-parse --show-toplevel)"
ROOT="${WORKTREE_ROOT:-$(dirname "$REPO")/.voni-worktrees}"
TARGET="$ROOT/$NAME"

mkdir -p "$ROOT"
AVAILABLE_KB="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
if [ "${AVAILABLE_KB:-0}" -lt 2097152 ]; then
  echo "worktree-create: need 2 GB free under $ROOT (have ${AVAILABLE_KB}K)" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$TARGET" "$BRANCH"
else
  git worktree add -b "$BRANCH" "$TARGET" "$BASE"
fi

(cd "$TARGET" && bash scripts/worktree-setup.sh)
echo "worktree-create: $TARGET ($BRANCH)"
