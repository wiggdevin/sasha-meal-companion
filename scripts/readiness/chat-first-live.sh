#!/usr/bin/env bash
# C8 of docs/plans/2026-09-19-chat-first.md ("landing 1: PR merged, production READY
# at main, receipts PASS, drift none") — task A7. Modeled on
# scripts/readiness/ai-first-live.sh. Exit 0 only when every check passes. Prints one
# PASS/FAIL line per receipt. Secrets are read into process memory from ZS Vault and
# never printed; env vars are listed by NAME only; any URL is redacted before printing.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_ID="prj_qOr6rQOZ5yfCd5VxB227apmg6pvF"
TEAM_ID="team_ZovXSbiQdKR8CvRpDYfAzbAr"
PROD_URL="https://sasha-meal-companion.vercel.app"
SUPABASE_REF="fivatgdpuenszxxnijpc"
PR="${1:-}"
fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
redact() { sed -E 's#(://)[^/@[:space:]]+@#\1***@#g'; }

# --- R1: PR merged, merge sha == origin/main HEAD -------------------------------
main_sha=$(cd "$REPO" && git fetch -q origin main && git rev-parse origin/main)
if [ -z "$PR" ]; then
  bad "R1 no PR number given"
  merge_sha=""
else
  pr_json=$(cd "$REPO" && gh pr view "$PR" --json mergedAt,mergeCommit 2>/dev/null)
  merged_at=$(printf '%s' "$pr_json" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print(d.get("mergedAt") or "")' 2>/dev/null)
  merge_sha=$(printf '%s' "$pr_json" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("mergeCommit") or {}).get("oid") or "")' 2>/dev/null)
  if [ -z "$merged_at" ] || [ -z "$merge_sha" ]; then
    bad "R1 PR #$PR not merged or not found"
  elif [ "$merge_sha" = "$main_sha" ]; then
    ok "R1 PR #$PR merged, sha $merge_sha == origin/main"
  else
    bad "R1 PR #$PR merge sha $merge_sha != origin/main $main_sha"
  fi
fi

# --- R2: latest production deployment READY at main sha -------------------------
tokfile=$(mktemp); chmod 600 "$tokfile"
printf 'header = "Authorization: Bearer %s"\n' "$(zsvault get vercel_token | tr -d '\n')" > "$tokfile"
dep=$(curl -sS -K "$tokfile" "https://api.vercel.com/v6/deployments?projectId=$PROJECT_ID&teamId=$TEAM_ID&target=production&limit=1")
dep_state=$(printf '%s' "$dep" | python3 -c 'import json,sys
d=json.load(sys.stdin); ds=d.get("deployments") or [{}]
x=ds[0]
print((x.get("state") or x.get("readyState") or "") + " " + (x.get("meta",{}).get("githubCommitSha") or ""))' 2>/dev/null)
ready_state="${dep_state%% *}"; ready_sha="${dep_state##* }"
if [ "$ready_state" = "READY" ] && [ -n "$ready_sha" ] && [ "$ready_sha" = "$main_sha" ]; then
  ok "R2 latest production deployment READY at main $main_sha"
else
  bad "R2 latest deployment state='$ready_state' sha='$ready_sha' (want READY at $main_sha)"
fi

# --- R3: GET /scan -> 307/308 Location .../coach?open=scan, no redirect follow --
scan_hdrs=$(curl -sS -D - -o /dev/null "$PROD_URL/scan")
scan_code=$(printf '%s' "$scan_hdrs" | head -1 | tr -d '\r' | awk '{print $2}')
scan_loc=$(printf '%s' "$scan_hdrs" | grep -i '^location:' | tail -1 | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//' | redact)
case "$scan_code" in
  307|308)
    case "$scan_loc" in
      */coach\?open=scan) ok "R3 GET /scan -> $scan_code, Location ends /coach?open=scan";;
      *) bad "R3 GET /scan -> $scan_code but Location='$scan_loc' (want .../coach?open=scan)";;
    esac ;;
  *) bad "R3 GET /scan -> $scan_code (want 307/308)";;
esac

# --- R4: GET /coach unauthenticated -> sign-in redirect (GUESS: no ai-first-live.sh analog) --
coach_hdrs=$(curl -sS -D - -o /dev/null "$PROD_URL/coach")
coach_code=$(printf '%s' "$coach_hdrs" | head -1 | tr -d '\r' | awk '{print $2}')
coach_loc=$(printf '%s' "$coach_hdrs" | grep -i '^location:' | tail -1 | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//' | redact)
case "$coach_code" in
  301|302|307|308)
    case "$coach_loc" in
      *[Ss][Ii][Gg][Nn]*|*[Ll][Oo][Gg][Ii][Nn]*) ok "R4 GET /coach unauthenticated -> $coach_code sign-in redirect" ;;
      *) bad "R4 GET /coach unauthenticated -> $coach_code but Location='$coach_loc' has no sign-in/login marker" ;;
    esac ;;
  200)
    body=$(curl -sS "$PROD_URL/coach")
    case "$body" in
      *[Ss]ign?[Ii]n*|*[Ll]ogin*) ok "R4 GET /coach unauthenticated -> 200 with sign-in marker in body" ;;
      *) bad "R4 GET /coach unauthenticated -> 200, no sign-in marker found" ;;
    esac ;;
  *) bad "R4 GET /coach unauthenticated -> $coach_code (want a sign-in redirect or 200 w/ marker)" ;;
esac

# --- R5: POST /api/coach unauthenticated -> 401 ---------------------------------
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$PROD_URL/api/coach" -H 'Content-Type: application/json' -d '{"message":"hi"}')
if [ "$code" = "401" ]; then ok "R5 POST /api/coach unauthenticated -> 401"; else bad "R5 POST /api/coach unauthenticated -> $code (expected 401)"; fi

# --- R6: production env has scan+capture+coach flags, no NEXT_PUBLIC_COACH_ENABLED --
envs=$(curl -sS -K "$tokfile" "https://api.vercel.com/v9/projects/$PROJECT_ID/env?teamId=$TEAM_ID")
rm -f "$tokfile"
env_report=$(printf '%s' "$envs" | python3 -c 'import json,sys
d=json.load(sys.stdin)
prod={e["key"] for e in d.get("envs",[]) if "production" in e.get("target",[])}
required=["FEATURE_SCAN","NEXT_PUBLIC_FEATURE_SCAN","CAPTURE_METHODS","NEXT_PUBLIC_CAPTURE_METHODS","COACH_ENABLED"]
missing=[k for k in required if k not in prod]
forbidden = "NEXT_PUBLIC_COACH_ENABLED" in prod
parts=[]
if missing: parts.append("missing:" + ",".join(missing))
if forbidden: parts.append("forbidden:NEXT_PUBLIC_COACH_ENABLED")
print("; ".join(parts))' 2>/dev/null)
if [ -z "$env_report" ]; then
  ok "R6 production env: required flags present, NEXT_PUBLIC_COACH_ENABLED absent (names only)"
else
  bad "R6 production env mismatch: $env_report (names only)"
fi

# --- R7: migration drift, exact check ai-first-live.sh uses ---------------------
if (cd "$REPO" && SUPABASE_PROJECT_REF="$SUPABASE_REF" SUPABASE_ACCESS_TOKEN="$(zsvault get supabase_access_token | tr -d '\n')" pnpm exec tsx scripts/check-migration-drift.ts >/tmp/chat-first-drift.txt 2>&1); then
  ok "R7 migration drift check clean"
else
  bad "R7 migration drift check failed (see /tmp/chat-first-drift.txt)"
fi

# --- R8: facet cache (food_facets) — exists, RLS forced, service-role-only policy, p CHECK ------
if bash "$REPO/scripts/readiness/facet-receipt.sh" "$SUPABASE_REF"; then
  ok "R8 facet cache receipt"
else
  bad "R8 facet cache receipt failed"
fi

exit $fail
