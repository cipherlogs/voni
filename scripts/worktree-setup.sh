#!/usr/bin/env bash
# Prepare a linked git worktree for this repo: share node_modules and local
# env files with the primary checkout, and keep the symlinks out of git status.
#
#   bash scripts/worktree-setup.sh
#
# Run inside the worktree. Safe to re-run.
set -euo pipefail

worktree_root="$(git rev-parse --show-toplevel)"
common_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_root="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"

if [ "$worktree_root" = "$main_root" ]; then
  echo "worktree-setup: already in the primary checkout ($worktree_root)"
  exit 0
fi

link() {
  local source="$1" target="$2"
  [ -e "$source" ] || return 0
  [ -e "$target" ] && return 0
  mkdir -p "$(dirname "$target")"
  ln -s "$source" "$target"
  echo "linked $target -> $source"
}

link "$main_root/node_modules" "$worktree_root/node_modules"
link "$main_root/voni/node_modules" "$worktree_root/voni/node_modules"
for file in .env .env.local .dev.vars; do
  link "$main_root/$file" "$worktree_root/$file"
  link "$main_root/voni/$file" "$worktree_root/voni/$file"
done

exclude="$common_git_dir/info/exclude"
mkdir -p "$(dirname "$exclude")"
touch "$exclude"
for entry in node_modules voni/node_modules; do
  grep -qxF "$entry" "$exclude" || printf '%s\n' "$entry" >> "$exclude"
done

echo "worktree-setup: ready ($worktree_root)"
