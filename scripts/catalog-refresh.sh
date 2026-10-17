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
# This script never touches production. It fails closed: the database URL must be local or must
# contain BRANCH_PROJECT_REF (the Supabase branch's own ref), and must not contain the ref of
# SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL when either is set.
set -euo pipefail

LABEL="${1:?usage: catalog-refresh.sh <version-label> [branch-db-url]}"
BRANCH_DB_URL="${2:-${BRANCH_DB_URL:-}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -n "$BRANCH_DB_URL" ] || { echo "pass the branch database URL (arg 2 or BRANCH_DB_URL)" >&2; exit 1; }
case "$BRANCH_DB_URL" in
  *@localhost*|*@127.0.0.1*) ;;
  *)
    [ -n "${BRANCH_PROJECT_REF:-}" ] && [[ "$BRANCH_DB_URL" == *"$BRANCH_PROJECT_REF"* ]] || {
      echo "refusing: set BRANCH_PROJECT_REF to the branch's ref and use that branch's URL" >&2
      exit 1
    }
    for u in "${SUPABASE_URL:-}" "${NEXT_PUBLIC_SUPABASE_URL:-}"; do
      ref="${u#https://}"; ref="${ref%%.*}"
      if [ -n "$ref" ] && [[ "$BRANCH_DB_URL" == *"$ref"* ]]; then
        echo "refusing: that URL names the production project" >&2
        exit 1
      fi
    done
    ;;
esac

echo "== 1/2 sizing dry run" >&2
"$ROOT/scripts/catalog-dry-run.sh" "$LABEL"

if [ -d "$ROOT/.venv" ]; then PYTHON="$ROOT/.venv/bin/python"; else PYTHON=python3; fi
echo "== 2/2 branch import" >&2
"$PYTHON" "$ROOT/scripts/import-fdc.py" --db-url "$BRANCH_DB_URL" --version-label "$LABEL"

cat >&2 <<MSG

Stopped. The branch import is done; the sign-off gate is the production import. Read docs/catalog/sizing.md (headroom must be at least 40 %), check the
branch import, then run the production import by hand as the owner. Nothing was sent to production.
MSG
