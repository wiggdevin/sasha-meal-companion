#!/usr/bin/env bash
# Alerts if the real (retained) Supabase backup — scripts/backup.sh's output
# under ~/Backups/supabase/meal-companion — is missing or has gone stale.
#
# scripts/backup.sh only ever writes one dump and exits; nothing watches
# whether the launchd timer that runs it is still firing. This script is the
# cheap periodic check: wire it into cron/launchd (or run it by hand) and it
# exits 1 with an ALERT on stderr when the newest dump is missing or older
# than the staleness threshold, 0 with an "ok:" line otherwise.
#
#   scripts/check-backup-staleness.sh [dest] [max_age_hours]
#     dest           default: ~/Backups/supabase/meal-companion
#     max_age_hours  default: 36 (backup.sh runs nightly; two missed nights
#                    plus slack for a late run is the alert threshold)
set -euo pipefail

DEST="${1:-${HOME}/Backups/supabase/meal-companion}"
MAX_AGE_HOURS="${2:-36}"

# Portable mtime (epoch seconds) for one file: GNU stat takes `-c`; BSD/macOS
# stat has no `-c` and takes `-f` instead (GNU's `-f` means something else
# entirely — filesystem status — so it can't be tried on both).
mtime_of() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1"
}

NEWEST=""
NEWEST_MTIME=-1
while IFS= read -r -d '' candidate; do
  candidate_mtime="$(mtime_of "${candidate}")"
  if [ "${candidate_mtime}" -gt "${NEWEST_MTIME}" ]; then
    NEWEST_MTIME="${candidate_mtime}"
    NEWEST="${candidate}"
  fi
done < <(find "${DEST}" -maxdepth 1 -type f -name '*.sql' -print0 2>/dev/null)

if [ -z "${NEWEST}" ]; then
  echo "ALERT: no backup dump found under ${DEST}" >&2
  exit 1
fi

MTIME="${NEWEST_MTIME}"
NOW="$(date +%s)"
AGE_HOURS=$(( (NOW - MTIME) / 3600 ))

if [ "${AGE_HOURS}" -gt "${MAX_AGE_HOURS}" ]; then
  echo "ALERT: newest backup (${NEWEST}) is ${AGE_HOURS}h old, older than the ${MAX_AGE_HOURS}h staleness threshold" >&2
  exit 1
fi

echo "ok: newest backup (${NEWEST}) is ${AGE_HOURS}h old"
