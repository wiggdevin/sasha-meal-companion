#!/usr/bin/env bash
# Create / inspect / reset / destroy a Supabase preview branch for the Phase 0 integration suite.
#
# Env the integration suite needs (print it with `env`, then export it in your shell):
#   SUPABASE_TEST_URL                https://<branch-ref>.supabase.co
#   SUPABASE_TEST_ANON_KEY           publishable key of the branch (user-scoped clients)
#   SUPABASE_TEST_SERVICE_ROLE_KEY   secret key of the branch (admin client, raw-SQL helpers)
#   SUPABASE_TEST_DB_URL             postgres:// connection string (migrations, psql assertions)
# `pnpm test:integration` skips every suite when SUPABASE_TEST_URL is unset.
set -euo pipefail

PROJECT_REF="fivatgdpuenszxxnijpc"
BRANCH="${2:-p0-database}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: scripts/db-branch.sh <create|env|reset|destroy> [branch-name]

  create    create the preview branch (default name: p0-database) and wait for it to go healthy
  env       print the SUPABASE_TEST_* export block for the branch
  reset     re-apply every migration from scratch, then apply supabase/seed/test_helpers.sql
  destroy   delete the preview branch

Requires: supabase CLI >= 2.116 (logged in), jq, psql.
EOF
  exit 2
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 3; }; }

# `branches list` is the only subcommand that reports lifecycle `status` (FUNCTIONS_DEPLOYED etc);
# `branches get` (used below for credentials) does not include it.
branch_status() {
  supabase branches list --project-ref "$PROJECT_REF" -o json \
    | jq -r --arg n "$BRANCH" '.[] | select(.name == $n) | .status'
}

# Real `branches get -o json` shape (2.116, differs from what this script originally assumed —
# no .ref/.db_host/.db_password/.status; credentials come back pre-assembled):
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY,
#   POSTGRES_URL, POSTGRES_URL_NON_POOLING, SUPABASE_DEFAULT_KEY (masked), SUPABASE_JWT_SECRET.
print_env() {
  local j
  j="$(supabase branches get "$BRANCH" --project-ref "$PROJECT_REF" -o json)"
  # POSTGRES_URL_NON_POOLING resolves IPv6-only and fails with "no route to host" on IPv4-only
  # networks; POSTGRES_URL (the transaction pooler) resolves IPv4 and works everywhere.
  cat <<EOF
export SUPABASE_TEST_URL="$(jq -r '.SUPABASE_URL' <<<"$j")"
export SUPABASE_TEST_ANON_KEY="$(jq -r '.SUPABASE_ANON_KEY' <<<"$j")"
export SUPABASE_TEST_SERVICE_ROLE_KEY="$(jq -r '.SUPABASE_SERVICE_ROLE_KEY' <<<"$j")"
export SUPABASE_TEST_DB_URL="$(jq -r '.POSTGRES_URL' <<<"$j")"
EOF
}

db_url() { print_env | sed -n 's/^export SUPABASE_TEST_DB_URL="\(.*\)"$/\1/p'; }

case "${1:-}" in
  create)
    need supabase; need jq
    if [ "$(branch_status)" != "" ]; then
      echo "branch $BRANCH already exists, reusing it" >&2
    else
      supabase branches create "$BRANCH" --project-ref "$PROJECT_REF" --region us-west-1 --persistent --yes
    fi
    for _ in $(seq 1 60); do
      [ "$(branch_status)" = "FUNCTIONS_DEPLOYED" ] && break
      sleep 10
    done
    print_env
    ;;
  env)
    need supabase; need jq
    print_env
    ;;
  reset)
    need supabase; need jq; need psql
    url="$(db_url)"
    supabase db reset --db-url "$url" --workdir "$ROOT" --yes
    psql "$url" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/seed/test_helpers.sql"
    echo "branch $BRANCH reset: migrations + test helpers applied"
    ;;
  destroy)
    need supabase
    supabase branches delete "$BRANCH" --project-ref "$PROJECT_REF" --yes
    ;;
  *) usage ;;
esac
