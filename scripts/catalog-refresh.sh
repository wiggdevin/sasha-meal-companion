#!/usr/bin/env bash
# Quarterly catalog refresh, up to the sizing sign-off (docs/catalog/import.md, Cadence).
#
#   ./scripts/catalog-refresh.sh 2026-12-15 <branch-db-url>
#
# 1. catalog-dry-run.sh sizing: throwaway local Postgres, import without activating, rewrite
#    docs/catalog/sizing.md.
# 2. The branch import: import-fdc.py --version-label against a NON-production database (a
#    Supabase branch). The URL is the second argument or BRANCH_DB_URL.
# 3. Stops. A person reads sizing.md and signs off; the production import is a manual owner step.
#
# This script never touches production: it refuses a URL that carries SUPABASE_URL's project.
set -euo pipefail

LABEL="${1:?usage: catalog-refresh.sh <version-label> [branch-db-url]}"
BRANCH_DB_URL="${2:-${BRANCH_DB_URL:-}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -n "$BRANCH_DB_URL" ] || { echo "pass the branch database URL (arg 2 or BRANCH_DB_URL)" >&2; exit 1; }
if [ -n "${PRODUCTION_PROJECT_REF:-}" ] && [[ "$BRANCH_DB_URL" == *"$PRODUCTION_PROJECT_REF"* ]]; then
  echo "refusing: that URL names the production project" >&2
  exit 1
fi

echo "== 1/2 sizing dry run" >&2
"$ROOT/scripts/catalog-dry-run.sh" "$LABEL"

if [ -d "$ROOT/.venv" ]; then PYTHON="$ROOT/.venv/bin/python"; else PYTHON=python3; fi
echo "== 2/2 branch import" >&2
"$PYTHON" "$ROOT/scripts/import-fdc.py" --db-url "$BRANCH_DB_URL" --version-label "$LABEL"

cat >&2 <<MSG

Stopped for sign-off. Read docs/catalog/sizing.md (headroom must be at least 40 %), check the
branch import, then run the production import by hand as the owner. Nothing was sent to production.
MSG
