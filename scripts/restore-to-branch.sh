#!/usr/bin/env bash
# Destructive restore only into a verified non-default Supabase branch or disposable local DB.
# SUPABASE_RESTORE_DB_URL (environment only), SUPABASE_ACCESS_TOKEN (branch metadata read).
# Usage: restore-to-branch.sh <dump.sql> --confirm <branch-ref-or-smc_restore_name>
# SQL dump + .sql.json integrity receipt must come from the repaired backup.sh.
set -euo pipefail
set +x
exec /usr/bin/python3 "$(dirname "$0")/lib/database_backup.py" restore "$@"
