#!/usr/bin/env bash
# Non-interactive launchd entry point: fixed tools, command-backed Vault credential retrieval.
set -euo pipefail
set +x
export PATH="${HOME}/bin:/opt/homebrew/bin:/usr/bin:/bin"
export PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
if [ -z "${SUPABASE_DB_URL:-}" ]; then
  SUPABASE_DB_URL="$("${HOME}/bin/zsvault" get sasha_supabase_db_url)"
  export SUPABASE_DB_URL
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"${ROOT}/scripts/backup.sh"
/usr/bin/python3 "${ROOT}/scripts/backup-storage.py"
"${ROOT}/scripts/check-backup-staleness.sh"
