#!/usr/bin/env bash
# C6/C10/C14 of docs/plans/2026-09-20-health-polish.md §4 — "landing N merged, production
# READY at main, migration applied, receipts PASS". Modeled on
# scripts/readiness/chat-first-live.sh. Exit 0 only when every check passes (SKIP does not
# fail the run). Prints one PASS/FAIL/SKIP line per check, then RESULT: PASS or RESULT: FAIL.
# Read-only against production: never writes to the database, never prints a secret or an
# env var value (names only).
#
# Usage: bash scripts/readiness/health-polish-live.sh <PR number> --landing 1|2|3 \
#          [--migrations "20261025090100 ..."] [--env-names "A B C"]
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_ID="prj_qOr6rQOZ5yfCd5VxB227apmg6pvF"
TEAM_ID="team_ZovXSbiQdKR8CvRpDYfAzbAr"
PROD_URL="https://sasha-meal-companion.vercel.app"
SUPABASE_REF="fivatgdpuenszxxnijpc"
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
skip() { printf 'SKIP  %s\n' "$1"; }
code_of() { curl -sS -o /dev/null -w '%{http_code}' "$PROD_URL$1"; }

# --- args ----------------------------------------------------------------------------------
PR=""; LANDING=""; MIGRATIONS=""; ENV_NAMES=""
if [ $# -gt 0 ]; then case "$1" in --*) : ;; *) PR="$1"; shift ;; esac; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --landing) LANDING="${2:-}"; shift 2 ;;
    --migrations) MIGRATIONS="${2:-}"; shift 2 ;;
    --env-names) ENV_NAMES="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
case "$LANDING" in
  1) : "${MIGRATIONS:=20261025090100}"; : "${ENV_NAMES:=HEALTH_INGEST_ENABLED HEALTH_TOKEN_KEY HEALTH_TZ}" ;;
  2) : "${MIGRATIONS:=20261025090200 20261025090300}" ;;
  3) : "${MIGRATIONS:=20261024093000 20261024093100 20261024093200 20261024093300}"
     : "${ENV_NAMES:=HEALTH_INGEST_ENABLED HEALTH_TOKEN_KEY HEALTH_TZ}" ;;
  *) bad "0 usage: --landing must be 1, 2, or 3 (got '$LANDING')" ;;
esac

# --- 1: PR MERGED and merge commit is an ancestor of origin/main ---------------------------
main_sha=$(cd "$REPO" && git fetch -q origin main 2>/dev/null && git rev-parse origin/main 2>/dev/null)
merge_sha=""
if [ -z "$PR" ]; then
  bad "1 no PR number given"
elif [ -z "$main_sha" ]; then
  bad "1 could not fetch/resolve origin/main"
else
  pr_json=$(cd "$REPO" && gh pr view "$PR" --json state,mergeCommit 2>/dev/null)
  pr_line=$(printf '%s' "$pr_json" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("state") or "") + "|" + ((d.get("mergeCommit") or {}).get("oid") or ""))' 2>/dev/null)
  pr_state="${pr_line%%|*}"; merge_sha="${pr_line#*|}"
  if [ "$pr_state" != "MERGED" ] || [ -z "$merge_sha" ]; then
    bad "1 PR #$PR not merged (state='$pr_state')"
  elif (cd "$REPO" && git merge-base --is-ancestor "$merge_sha" origin/main 2>/dev/null); then
    ok "1 PR #$PR MERGED, $merge_sha is an ancestor of origin/main"
  else
    bad "1 PR #$PR MERGED but $merge_sha is not an ancestor of origin/main"
  fi
fi

# --- vercel token, shared by checks 2 and 5 -------------------------------------------------
vtokfile=$(mktemp); chmod 600 "$vtokfile"
printf 'header = "Authorization: Bearer %s"\n' "$(zsvault get vercel_token 2>/dev/null | tr -d '\n')" > "$vtokfile"

# --- 2: latest production deployment READY at main (or the PR merge commit) ----------------
dep=$(curl -sS -K "$vtokfile" "https://api.vercel.com/v6/deployments?projectId=$PROJECT_ID&teamId=$TEAM_ID&target=production&limit=5")
dep_line=$(printf '%s' "$dep" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
for x in d.get("deployments") or []:
    if (x.get("state") or x.get("readyState") or "") == "READY":
        print(((x.get("meta") or {}).get("githubCommitSha") or "") + "|" + (x.get("url") or ""))
        break
else:
    print("|")' 2>/dev/null)
ready_sha="${dep_line%%|*}"; dep_url="${dep_line#*|}"
want_short="${main_sha:-$merge_sha}"; want_short="${want_short:-<unknown>}"; want_short="${want_short:0:7}"
if [ -n "$ready_sha" ] && { [ "$ready_sha" = "$main_sha" ] || [ "$ready_sha" = "$merge_sha" ]; }; then
  ok "2 latest production deployment READY at ${ready_sha:0:7}, https://$dep_url"
else
  bad "2 latest deployment sha='${ready_sha:-<none>}' (want $want_short)"
fi

# --- 3: production home page 200 with the app's <title> (follows the sign-in redirect) -----
home_body=$(mktemp)
home_code=$(curl -sS -L -o "$home_body" -w '%{http_code}' "$PROD_URL/")
if [ "$home_code" = "200" ] && grep -q '<title>Sasha</title>' "$home_body"; then
  ok "3 GET $PROD_URL/ -> 200 with <title>Sasha</title>"
else
  bad "3 GET $PROD_URL/ -> $home_code (want 200 with <title>Sasha</title>)"
fi
rm -f "$home_body"

# --- 4: migrations present on production (Supabase Management API, read-only) --------------
check_migrations() {
  local versions="$1"
  if [ -z "$versions" ]; then skip "4 no migrations specified"; return; fi
  local token; token="$(zsvault get supabase_access_token 2>/dev/null | tr -d '\n')"
  if [ -z "$token" ]; then skip "4 migration check (supabase_access_token not available in vault)"; return; fi
  local v in_list=""
  for v in $versions; do
    case "$v" in ''|*[!0-9]*) bad "4 invalid migration version token '$v'"; return ;; esac
    if [ -z "$in_list" ]; then in_list="'$v'"; else in_list="$in_list,'$v'"; fi
  done
  local sql="select version from supabase_migrations.schema_migrations where version in ($in_list);"
  local body tf resp
  body=$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$sql")
  tf=$(mktemp); chmod 600 "$tf"
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$tf"
  resp=$(curl -sS -K "$tf" -H 'Content-Type: application/json' -X POST "https://api.supabase.com/v1/projects/$SUPABASE_REF/database/query" --data "$body")
  rm -f "$tf"
  local verdict
  verdict=$(python3 -c 'import json,sys
resp, versions = sys.argv[1], sys.argv[2].split()
try:
    rows = json.loads(resp)
    present = {r.get("version") for r in rows} if isinstance(rows, list) else set()
except Exception:
    print("ERROR"); sys.exit(0)
missing = [v for v in versions if v not in present]
print(("MISSING:" + ",".join(missing)) if missing else "OK")' "$resp" "$versions" 2>/dev/null)
  case "$verdict" in
    OK) ok "4 migrations present on production: $versions" ;;
    MISSING:*) bad "4 migrations missing on production: ${verdict#MISSING:}" ;;
    *) bad "4 migration check: unreadable Management API response" ;;
  esac
}
check_migrations "$MIGRATIONS"

# --- 5: env names present on Vercel production (names only) --------------------------------
if [ -z "$ENV_NAMES" ]; then
  skip "5 no env names specified for this landing"
else
  envs=$(curl -sS -K "$vtokfile" "https://api.vercel.com/v9/projects/$PROJECT_ID/env?teamId=$TEAM_ID")
  for n in $ENV_NAMES; do
    present=$(python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
name=sys.argv[1]
found=any(e.get("key")==name and "production" in (e.get("target") or []) for e in d.get("envs") or [])
print("1" if found else "0")' "$n" <<<"$envs" 2>/dev/null)
    if [ "$present" = "1" ]; then ok "5 env $n present on production (name only)"; else bad "5 env $n missing on production"; fi
  done
fi
rm -f "$vtokfile"

# --- landing-specific checks -----------------------------------------------------------------
check_not_503() {
  local path="$1" label="$2" c; c=$(code_of "$path")
  if [ -z "$c" ] || [ "$c" = "503" ]; then
    bad "$label GET $path -> ${c:-<none>} (503 means the ingest flag is still off)"
  else
    ok "$label GET $path -> $c (not 503)"
  fi
}
case "$LANDING" in
  1)
    check_not_503 "/api/health/ingest" "L1"
    ;;
  2)
    # coach surface is alive: /api/coach is POST-only (405 to GET is healthy), /coach redirects
    # unauthenticated visitors to sign-in (3xx is healthy) — only a 5xx or no response fails.
    c1=$(code_of "/api/coach")
    case "$c1" in
      5*|'') c2=$(code_of "/coach")
             case "$c2" in
               5*|'') bad "L2 GET /api/coach -> ${c1:-<none>}, GET /coach -> ${c2:-<none>} (want non-5xx)" ;;
               *) ok "L2 GET /coach -> $c2 (not 5xx; /api/coach was ${c1:-<none>})" ;;
             esac ;;
      *) ok "L2 GET /api/coach -> $c1 (not 5xx)" ;;
    esac
    ;;
  3)
    check_not_503 "/api/health/ingest" "L3"
    body_code=$(code_of "/body")
    case "$body_code" in
      2*|3*) ok "L3 GET /body -> $body_code" ;;
      *) bad "L3 GET /body -> $body_code (want 200/3xx)" ;;
    esac
    ;;
esac

if [ "$fail" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
exit $fail
