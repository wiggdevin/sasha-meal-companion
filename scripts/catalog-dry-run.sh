#!/usr/bin/env bash
# Dry-run sizing (architecture §7.1). Brings up a throwaway Postgres 17 on Colima/Docker,
# applies the Phase 0 catalog shell and the three Phase 1 migrations, imports all three FDC
# sources WITHOUT activating, runs the size report and writes docs/catalog/sizing.md.
#
#   ./scripts/catalog-dry-run.sh 2026-09-12
#
# Nothing here touches Supabase. The container is removed at the end unless KEEP=1.
set -euo pipefail

LABEL="${1:?usage: catalog-dry-run.sh <version-label>}"
case "$LABEL" in
  *[!A-Za-z0-9._-]*|"")
    echo "version label must match [A-Za-z0-9._-]+, got: $LABEL" >&2
    exit 1
    ;;
esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=smc-catalog-dryrun
PORT=5433
URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres"

command -v docker >/dev/null || { echo "docker is not on PATH; start Colima first" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon is not running; run: colima start" >&2; exit 1; }

cleanup() { [ "${KEEP:-0}" = "1" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres \
  -p "${PORT}:5432" postgres:17 >/dev/null

echo "waiting for postgres 17" >&2
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

# The roles the grants migration references exist on Supabase, not in a bare image.
psql "$URL" -v ON_ERROR_STOP=1 -c \
  "do \$\$ begin
     if not exists (select 1 from pg_roles where rolname = 'anon') then
       create role anon nologin; end if;
     if not exists (select 1 from pg_roles where rolname = 'authenticated') then
       create role authenticated nologin; end if;
     if not exists (select 1 from pg_roles where rolname = 'service_role') then
       create role service_role nologin bypassrls; end if;
   end \$\$;"

for m in \
  "$ROOT/supabase/migrations/20260911000100_catalog_shell.sql" \
  "$ROOT/supabase/migrations/20260912090000_catalog_tables.sql" \
  "$ROOT/supabase/migrations/20260912090050_catalog_activate.sql" \
  "$ROOT/supabase/migrations/20260912090200_catalog_grants.sql"; do
  echo "applying $(basename "$m")" >&2
  psql "$URL" -v ON_ERROR_STOP=1 -f "$m"
done

# No .venv in the repo: use one only if it already exists (created by hand, never by this
# script), otherwise fall back to system python3 after confirming the deps are importable.
if [ -d "$ROOT/.venv" ]; then
  PYTHON="$ROOT/.venv/bin/python"
else
  if python3 -c 'import psycopg, requests' >/dev/null 2>&1; then
    PYTHON=python3
  else
    echo "pip install -r scripts/requirements.txt (or create .venv)" >&2
    exit 1
  fi
fi
"$PYTHON" "$ROOT/scripts/import-fdc.py" \
  --db-url "$URL" --version-label "$LABEL" --dry-run

mkdir -p "$ROOT/docs/catalog"
{
  echo "# Catalog sizing — dry run ${LABEL}"
  echo
  echo "Local Postgres 17 (docker \`postgres:17\` on Colima), Foundation + SR Legacy + FNDDS"
  echo "loaded by \`scripts/import-fdc.py --dry-run\`. Regenerate with:"
  echo
  echo '```'
  echo "./scripts/catalog-dry-run.sh ${LABEL}"
  echo '```'
  echo
  echo "Supabase Pro disk is 8 GiB. Acceptance criterion 1 needs headroom of at least 40 %."
  echo "If it does not clear 40 %, FNDDS moves to on-demand and that decision is recorded here."
  echo
  psql "$URL" -v ON_ERROR_STOP=1 -f "$ROOT/scripts/catalog-size-report.sql"
  echo
  echo '## Per-source report'
  echo
  PER_SOURCE_SQL="$(mktemp)"
  echo "select source, version_label, is_active, row_counts from catalog_versions where version_label = :'label' order by source;" > "$PER_SOURCE_SQL"
  psql "$URL" -v ON_ERROR_STOP=1 -v label="$LABEL" -f "$PER_SOURCE_SQL"
  rm -f "$PER_SOURCE_SQL"
} > "$ROOT/docs/catalog/sizing.md"

echo "wrote docs/catalog/sizing.md" >&2
