#!/usr/bin/env bash
# R8 — facet cache receipt (read-only). Usage: facet-receipt.sh <supabase-project-ref>
# Asserts on the given project: public.food_facets exists, RLS enabled AND forced, exactly one policy
# (service_role), no table grant to authenticated, and the food_facets_p_range CHECK is present.
# Token: SUPABASE_ACCESS_TOKEN in the environment, else ZS Vault `supabase_access_token`. Never printed.
set -u
ref="${1:?project ref}"
token="${SUPABASE_ACCESS_TOKEN:-$(zsvault get supabase_access_token | tr -d '\n')}"
tokfile="$(mktemp)"; trap 'rm -f "$tokfile"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$tokfile"
read -r -d '' sql <<'SQL'
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name='food_facets') as table_present,
  (select coalesce(bool_and(c.relrowsecurity and c.relforcerowsecurity), false) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='food_facets') as rls_forced,
  (select count(*) from pg_policies where schemaname='public' and tablename='food_facets') as policy_count,
  (select coalesce(string_agg(array_to_string(roles, ','), ';'), '') from pg_policies where schemaname='public' and tablename='food_facets') as policy_roles,
  (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='food_facets' and grantee='authenticated') as authenticated_grants,
  (select count(*) from pg_constraint where conname='food_facets_p_range') as p_range_check
SQL
body="$(python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' <<< "$sql")"
resp="$(curl -sS -K "$tokfile" -H 'Content-Type: application/json' -X POST "https://api.supabase.com/v1/projects/$ref/database/query" --data "$body")"
python3 - "$resp" <<'PY'
import json,sys
try:
    rows=json.loads(sys.argv[1])
except Exception as e:
    print("R8 FAIL: unreadable response"); sys.exit(1)
if not isinstance(rows,list) or not rows:
    print("R8 FAIL: no row", str(rows)[:200]); sys.exit(1)
r=rows[0]
checks=[
 ("table present", int(r.get("table_present",0))==1),
 ("RLS enabled and forced", r.get("rls_forced") is True),
 ("exactly one policy", int(r.get("policy_count",0))==1),
 ("policy role is service_role only", r.get("policy_roles")=="service_role"),
 ("no grant to authenticated", int(r.get("authenticated_grants",1))==0),
 ("p range CHECK present", int(r.get("p_range_check",0))==1),
]
bad=[n for n,okv in checks if not okv]
print("R8 facet cache:", "; ".join(f"{n}={'ok' if okv else 'FAIL'}" for n,okv in checks))
sys.exit(1 if bad else 0)
PY
