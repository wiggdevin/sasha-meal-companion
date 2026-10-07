#!/usr/bin/env bash
# Probe for the watcher session. Read-only. Usage: scripts/watch-lanes.sh <suffix>...   e.g. p0-A p0-B  or  F G H I
# Prints one block per lane worktree (../meal-companion-<suffix>): branch, ahead/dirty, last commit age,
# claude process alive, open PR + CI conclusions from the API (never the dashboard), merge state.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="wiggdevin/sasha-meal-companion"
echo "== $(date '+%Y-%m-%d %H:%M') · origin/main $(git -C "$ROOT" fetch -q origin main 2>/dev/null; git -C "$ROOT" rev-parse --short origin/main) · battery: $(pmset -g batt | grep -oE '[0-9]+%;[^;]+' | head -1)"
for s in "$@"; do
  W="$ROOT/../meal-companion-$s"
  [ -d "$W" ] || { echo "-- $s: NO WORKTREE at $W"; continue; }
  B=$(git -C "$W" branch --show-current)
  AHEAD=$(git -C "$W" rev-list --count origin/main.."$B" 2>/dev/null || echo "?")
  DIRTY=$(git -C "$W" status --porcelain | wc -l | tr -d ' ')
  LAST=$(git -C "$W" log -1 --format='%cr · %s' 2>/dev/null)
  ALIVE=$(pgrep -fl "claude" | grep -c "meal-companion-$s" || true)
  PR=$(gh pr list --repo "$REPO" --head "$B" --state all --json number,state,mergedAt,mergeStateStatus --jq 'if length == 0 then "" else .[0] | "#\(.number) \(.state) merged=\(.mergedAt // "-") mergeState=\(.mergeStateStatus // "-")" end' 2>/dev/null)
  echo "-- $s  [$B]  ahead=$AHEAD dirty=$DIRTY claude_procs=$ALIVE"
  echo "   last: $LAST"
  echo "   pr:   ${PR:-none}"
  N=$(echo "$PR" | grep -oE '#[0-9]+' | tr -d '#')
  if [ -n "$N" ]; then
    SHA=$(gh pr view "$N" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null)
    [ -n "$SHA" ] && gh api "repos/$REPO/actions/runs?head_sha=$SHA&per_page=3" --jq '.workflow_runs[] | "   ci:   \(.name) \(.status)/\(.conclusion // "-") \(.html_url)"' 2>/dev/null
  fi
done
echo "== worktrees:"; git -C "$ROOT" worktree list | sed 's/^/   /'
