#!/usr/bin/env bash
# Installs (or reinstalls) the launchd timer that runs scripts/backup.sh nightly.
#   scripts/install-backup-timer.sh
set -euo pipefail

LABEL="com.zs.smc-backup"
SELF_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SELF_DIR}/launchd/${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

[ -f "${SRC}" ] || { echo "no such plist: ${SRC}" >&2; exit 1; }

umask 077
plutil -lint "${SRC}" >/dev/null
[ -x /opt/homebrew/opt/postgresql@17/bin/pg_dump ] || { echo "PostgreSQL 17 tools are required" >&2; exit 1; }
[ -x "${HOME}/bin/zsvault" ] || { echo "ZS Vault is required for unattended credentials" >&2; exit 1; }

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cp "${SRC}" "${DEST}"
chmod 600 "${DEST}"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${DEST}"
launchctl print "gui/$(id -u)/${LABEL}" >/dev/null

echo
echo "installed ${LABEL}. verify with:"
echo "  launchctl kickstart -k gui/\$(id -u)/${LABEL} && ls ~/Backups/supabase/meal-companion"
