#!/usr/bin/env bash
# C10 of docs/plans/2026-09-19-ai-first-companion.md — "landed and live".
# Exit 0 only when every check passes. Prints one line per check. Secrets are read into
# process memory from ZS Vault and never printed; env vars are listed by NAME only.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_ID="prj_qOr6rQOZ5yfCd5VxB227apmg6pvF"
TEAM_ID="team_ZovXSbiQdKR8CvRpDYfAzbAr"
PROD_URL="https://sasha-meal-companion.vercel.app"
PR="${1:-}"   # PR number, optional; when given, its merge state is checked
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

# 1. PR merged (when given)
if [ -n "$PR" ]; then
  state=$(cd "$REPO" && gh pr view "$PR" --json state,mergedAt --jq '.state + " " + (.mergedAt // "")' 2>/dev/null)
  case "$state" in MERGED*) ok "PR #$PR merged ($state)";; *) bad "PR #$PR not merged ($state)";; esac
fi

# 2. main sha == Vercel production READY sha
main_sha=$(cd "$REPO" && git fetch -q origin main && git rev-parse origin/main)
tokfile=$(mktemp); chmod 600 "$tokfile"
printf 'header = "Authorization: Bearer %s"\n' "$(zsvault get vercel_token | tr -d '\n')" > "$tokfile"
dep=$(curl -s -K "$tokfile" "https://api.vercel.com/v6/deployments?projectId=$PROJECT_ID&teamId=$TEAM_ID&target=production&limit=5")
ready_sha=$(printf '%s' "$dep" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for x in d.get("deployments",[]):
    if x.get("state")=="READY" or x.get("readyState")=="READY":
        print(x.get("meta",{}).get("githubCommitSha","")); break')
if [ -n "$ready_sha" ] && [ "$ready_sha" = "$main_sha" ]; then ok "Vercel production READY at main $main_sha"; else bad "Vercel READY sha '$ready_sha' != origin/main $main_sha"; fi

# 3. Unauthenticated coach → 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PROD_URL/api/coach" -H 'Content-Type: application/json' -d '{"message":"hi"}')
if [ "$code" = "401" ]; then ok "POST /api/coach unauthenticated → 401"; else bad "POST /api/coach unauthenticated → $code (expected 401)"; fi

# 4. TYPESAFE_API_KEY present on production (by name)
envs=$(curl -s -K "$tokfile" "https://api.vercel.com/v9/projects/$PROJECT_ID/env?teamId=$TEAM_ID")
rm -f "$tokfile"
if printf '%s' "$envs" | python3 -c 'import json,sys
d=json.load(sys.stdin)
ok=any(e["key"]=="TYPESAFE_API_KEY" and "production" in e.get("target",[]) for e in d.get("envs",[]))
sys.exit(0 if ok else 1)'; then ok "TYPESAFE_API_KEY present on production (name only)"; else bad "TYPESAFE_API_KEY missing on production"; fi

# 5. Migration drift clean (read-only)
if (cd "$REPO" && pnpm exec tsx scripts/check-migration-drift.ts >/tmp/ai-first-drift.txt 2>&1); then ok "migration drift check clean"; else bad "migration drift check failed (see /tmp/ai-first-drift.txt)"; fi

exit $fail
