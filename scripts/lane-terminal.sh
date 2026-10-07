#!/usr/bin/env bash
# Open a new Terminal window in a lane worktree and start Claude Code on the house driver model
# (Fable 5.1, effort high) with the lane's prompt already sent. Usage:
#   scripts/lane-terminal.sh <worktree-suffix> [prompt-file]
#   scripts/lane-terminal.sh F docs/plans/2026-09-11-phase-1-2/prompts/F.txt
# With no prompt-file the session opens idle and you paste the prompt yourself.
#
# The command runs from a small per-lane runner script, not from the `do script` line itself:
# a 1.4 KB single-quoted prompt typed straight into a brand-new Terminal window raced the shell
# start-up and was left sitting unexecuted at the prompt in 4 of 5 windows (2026-09-11). The
# runner also clears CLAUDE_CODE_CHILD_SESSION (inherited when the launcher is run from inside a
# Claude Code terminal pane) so the lane session keeps its transcript and can be resumed.
set -euo pipefail
S="${1:?worktree suffix, e.g. F or p0-A}"; PF="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$ROOT/../meal-companion-$S"; [ -d "$W" ] || { echo "no worktree at $W" >&2; exit 1; }
MODEL="claude-fable-5-1"
RUNNER="$(mktemp -t "lane-$S.XXXXXX")"
{
  echo '#!/usr/bin/env bash'
  printf 'cd %q || exit 1\n' "$W"
  echo 'unset CLAUDE_CODE_CHILD_SESSION'
  echo 'export CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1'
  if [ -n "$PF" ]; then
    [ -f "$PF" ] || { echo "no prompt file $PF" >&2; exit 1; }
    ABS_PF="$(cd "$(dirname "$PF")" && pwd)/$(basename "$PF")"
    printf 'exec claude --model %q "$(cat %q)"\n' "$MODEL" "$ABS_PF"
  else
    printf 'exec claude --model %q\n' "$MODEL"
  fi
} > "$RUNNER"
chmod +x "$RUNNER"
# Open the window first, let the login shell finish starting, then type the (short) command into
# that specific tab: typing into a window that is still starting up mangled the first characters.
osascript - "bash $RUNNER" <<'APPLESCRIPT'
on run argv
  tell application "Terminal"
    activate
    set t to do script ""
    delay 1.5
    do script (item 1 of argv) in t
  end tell
end run
APPLESCRIPT
echo "opened Terminal window in $W on $MODEL${PF:+ with prompt $PF} (runner $RUNNER)"
