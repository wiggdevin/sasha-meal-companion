#!/usr/bin/env bash
# A single, private, atomic PostgreSQL 17 SQL dump. Credentials come only from environment.
# SUPABASE_DB_URL or PGHOST/PGDATABASE/PGUSER plus PGPASSWORD/PGPASSFILE.
# PG_BIN defaults to /opt/homebrew/opt/postgresql@17/bin. --destination is useful for drills.
set -euo pipefail
set +x
exec /usr/bin/python3 "$(dirname "$0")/lib/database_backup.py" backup "$@"
