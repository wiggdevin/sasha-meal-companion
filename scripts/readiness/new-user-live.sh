#!/usr/bin/env bash
# Read-only production gate for docs/plans/2026-09-20-new-user-cards.md.
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_ID="prj_qOr6rQOZ5yfCd5VxB227apmg6pvF"
TEAM_ID="team_ZovXSbiQdKR8CvRpDYfAzbAr"
SUPABASE_REF="fivatgdpuenszxxnijpc"
MIGRATIONS="20261026090000 20261026090100 20261026090200"
REQUIRED_ENVS="SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY CRON_SECRET"
retired_prefix=$(printf '\123\101\123\110\101')
RETIRED_ENVS="${retired_prefix}_SYNC_TOKEN ${retired_prefix}_USER_ID ${retired_prefix}_MCP_TOKEN"
fail=0
dry=0
pr=""
temp_files=""

ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
dry_line() { printf 'DRY   %s\n' "$1"; }
cleanup() { for path in $temp_files; do rm -f "$path"; done; }
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --dry) dry=1; shift ;;
    --*) bad "0 unknown option $1"; shift ;;
    *) if [ -z "$pr" ]; then pr="$1"; else bad "0 unexpected argument"; fi; shift ;;
  esac
done

if [ "$dry" -eq 1 ]; then
  : "${pr:=<number>}"
  dry_line "1 PR #$pr is merged into remote main"
  dry_line "2 remote main SHA equals the Vercel READY deployment SHA"
  dry_line "3 migrations present: $MIGRATIONS"
  dry_line "4 required env names present and retired singleton env names absent"
  dry_line "5 GET /sign-in -> 200 with neutral HTML"
  dry_line "6 GET /api/sync -> 404"
  dry_line "7 GET /api/targets -> 401"
  dry_line "8 POST /api/sync/ops -> 401"
  exit 0
fi

# 1. The requested PR must be merged into the current remote main.
main_sha=$(cd "$REPO" && git fetch -q origin main 2>/dev/null && git rev-parse origin/main 2>/dev/null)
merge_sha=""
if [ -z "$pr" ]; then
  bad "1 no PR number given"
else
  pr_json=$(cd "$REPO" && gh pr view "$pr" --json state,mergeCommit 2>/dev/null)
  pr_line=$(printf '%s' "$pr_json" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("state") or "") + "|" + ((d.get("mergeCommit") or {}).get("oid") or ""))')
  pr_state="${pr_line%%|*}"; merge_sha="${pr_line#*|}"
  if [ "$pr_state" = "MERGED" ] && [ -n "$merge_sha" ] \
    && (cd "$REPO" && git merge-base --is-ancestor "$merge_sha" origin/main 2>/dev/null); then
    ok "1 PR #$pr is merged into remote main"
  else
    bad "1 PR #$pr is not merged into remote main"
  fi
fi

# Auth headers stay in mode-600 files; only names and verdicts reach stdout.
vercel_config=$(mktemp)
chmod 600 "$vercel_config"
temp_files="$temp_files $vercel_config"
printf 'header = "Authorization: Bearer %s"\n' \
  "$(zsvault get vercel_token 2>/dev/null | tr -d '\n')" > "$vercel_config"

# 2. The READY production deployment must be the exact remote-main commit.
deployments=$(curl -sS -K "$vercel_config" \
  "https://api.vercel.com/v6/deployments?projectId=$PROJECT_ID&teamId=$TEAM_ID&target=production&limit=5")
ready_line=$(printf '%s' "$deployments" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
for item in d.get("deployments") or []:
    if (item.get("state") or item.get("readyState")) == "READY":
        print(((item.get("meta") or {}).get("githubCommitSha") or "") + "|" + (item.get("url") or ""))
        break')
ready_sha="${ready_line%%|*}"
ready_url="${ready_line#*|}"
# Probe the production alias, not the deployment URL: Vercel SSO protection gates every
# per-deployment *.vercel.app URL and answers 302 for it, while the alias is what accounts open.
prod_alias=$(curl -sS -K "$vercel_config" \
  "https://api.vercel.com/v9/projects/$PROJECT_ID?teamId=$TEAM_ID" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
aliases=((d.get("targets") or {}).get("production") or {}).get("alias") or []
print(aliases[0] if aliases else "")')
PROD_URL="${prod_alias:+https://$prod_alias}"
if [ -n "$main_sha" ] && [ "$ready_sha" = "$main_sha" ]; then
  ok "2 remote main SHA equals the Vercel READY deployment SHA"
else
  bad "2 remote main SHA does not equal the Vercel READY deployment SHA"
fi

# 3. Query only the migration ledger.
supabase_config=$(mktemp)
chmod 600 "$supabase_config"
temp_files="$temp_files $supabase_config"
printf 'header = "Authorization: Bearer %s"\n' \
  "$(zsvault get supabase_access_token 2>/dev/null | tr -d '\n')" > "$supabase_config"
migration_sql="select version from supabase_migrations.schema_migrations where version in ('20261026090000','20261026090100','20261026090200');"
migration_body=$(python3 -c 'import json,sys; print(json.dumps({"query":sys.argv[1]}))' "$migration_sql")
migration_rows=$(curl -sS -K "$supabase_config" -H 'Content-Type: application/json' -X POST \
  "https://api.supabase.com/v1/projects/$SUPABASE_REF/database/query" --data "$migration_body")
migration_verdict=$(printf '%s' "$migration_rows" | python3 -c 'import json,sys
wanted=set(sys.argv[1].split())
try: rows=json.load(sys.stdin); present={str(row.get("version")) for row in rows}
except Exception: present=set()
print("ok" if wanted <= present else "missing")' "$MIGRATIONS")
if [ "$migration_verdict" = "ok" ]; then ok "3 migrations present: $MIGRATIONS";
else bad "3 one or more required migrations are absent"; fi

# 4. Inspect Vercel environment keys, never values.
env_json=$(curl -sS -K "$vercel_config" \
  "https://api.vercel.com/v9/projects/$PROJECT_ID/env?teamId=$TEAM_ID")
env_verdict=$(printf '%s' "$env_json" | python3 -c 'import json,sys
required=set(sys.argv[1].split()); retired=set(sys.argv[2].split())
try: data=json.load(sys.stdin)
except Exception: data={}
names={e.get("key") for e in data.get("envs") or [] if "production" in (e.get("target") or [])}
print("ok" if required <= names and not (retired & names) else "bad")' "$REQUIRED_ENVS" "$RETIRED_ENVS")
if [ "$env_verdict" = "ok" ]; then
  ok "4 required env names present and retired singleton env names absent"
else
  bad "4 required env-name presence or retired env-name absence check failed"
fi

http_code() {
  if [ -z "$PROD_URL" ]; then printf '000'; else curl -sS -o /dev/null -w '%{http_code}' "$PROD_URL$1"; fi
}

# `app/api/sync/ops/route.ts` exports POST only, so a GET probe answers 405 and proves nothing
# about authentication. Empty JSON body, and no Authorization header: the unauthenticated case.
post_code() {
  if [ -z "$PROD_URL" ]; then printf '000'; else
    curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H 'Content-Type: application/json' --data '{}' "$PROD_URL$1"
  fi
}

# 5. Sign-in remains public and carries no personal name.
sign_in_body=$(mktemp)
chmod 600 "$sign_in_body"
temp_files="$temp_files $sign_in_body"
if [ -n "$PROD_URL" ]; then
  sign_in_code=$(curl -sS -o "$sign_in_body" -w '%{http_code}' "$PROD_URL/sign-in")
else
  sign_in_code="000"
fi
if [ "$sign_in_code" = "200" ] && ! python3 -c 'import re,sys
names=("".join(map(chr,[83,97,115,104,97])),"".join(map(chr,[68,101,118,105,110])))
pattern=r"\b(?:"+"|".join(map(re.escape,names))+r")\b"
raise SystemExit(0 if not re.search(pattern, open(sys.argv[1]).read(), re.I) else 1)' "$sign_in_body"; then
  bad "5 GET /sign-in is not neutral"
elif [ "$sign_in_code" = "200" ]; then
  ok "5 GET /sign-in -> 200 with neutral HTML"
else
  bad "5 GET /sign-in -> $sign_in_code (want 200)"
fi

# 6-8. Public endpoint status contract.
sync_code=$(http_code "/api/sync")
if [ "$sync_code" = "404" ]; then ok "6 GET /api/sync -> 404"; else bad "6 GET /api/sync -> $sync_code (want 404)"; fi
targets_code=$(http_code "/api/targets")
if [ "$targets_code" = "401" ]; then ok "7 GET /api/targets -> 401"; else bad "7 GET /api/targets -> $targets_code (want 401)"; fi
ops_code=$(post_code "/api/sync/ops")
if [ "$ops_code" = "401" ]; then ok "8 POST /api/sync/ops -> 401"; else bad "8 POST /api/sync/ops -> $ops_code (want 401)"; fi

if [ "$fail" -eq 0 ]; then printf 'RESULT: PASS\n'; else printf 'RESULT: FAIL\n'; fi
exit "$fail"
