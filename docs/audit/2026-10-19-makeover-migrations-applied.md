# Makeover migrations applied to production, 2026-10-19

Project `fivatgdpuenszxxnijpc`. Request: the coordinator's Mac-session step for PRs #236 and #237;
Devin, in the thread, 2026-10-19: "finish merging everything else".

## Review
GPT-6.1 Sol reviewed all four forward files and their downs against the `_sync_upsert` body
reconstructed from `main` (`b0fc2736`). No BLOCK; verdict APPLY. It confirmed each of the four
anchors in `20270107090000` occurs once, the reverse anchors restore the function byte for byte,
the JSON-null refusal runs before any write, an omitted key keeps the stored list and an insert
gets `'{}'`, and `_sync_upsert` stays service-role only. Two WARNs are in the down files only
(not run): the data-loss guards in both `.down.sql` files do not lock the table before checking,
and the downs set no `lock_timeout`/`statement_timeout`. Fix both before any rollback.

## Pre-check (read-only)
191 migrations recorded, latest `20270106090200`; `apply-migrations.py` dry run on `main` reported
nothing missing. 7 `user_settings` rows, 1 `shopping_periods` row. Neither new column existed. On the
live `_sync_upsert`, each of the four patch anchors occurred exactly once.

## Backup
`~/Backups/supabase/meal-companion/2026-10-19T080246Z-7970ccb8.sql` (23,822,756 bytes,
sha256 `3dd4a403a0ed886960e417cb2f699219a2d4842ddd1db289bcd7e67dde1f4a88`), taken by `scripts/backup.sh`.

## Applied
From `main` with each PR's files added (not committed), `scripts/apply-migrations.py --commit`:
- PR #236: `20270107090000_user_settings_companions_hidden`, `20270107090100_user_settings_companions_hidden_validate`, 08:06:09 UTC.
- PR #237: `20270107090200_shopping_period_titles`, `20270107090300_shopping_period_titles_validate`, 08:08:08 UTC.

Each dry run before listed only that PR's two files; each run after reported all recorded. The
ledger holds 195 rows, the four `20270107…` versions included.

## Verified (read-only SQL)
- `user_settings.companions_hidden`: `text[]`, NOT NULL, default `'{}'`; `user_settings_companions_hidden_check` validated; 0 rows off the default.
- `_sync_upsert` carries the `companions_hidden_null` refusal; `authenticated` cannot execute it, `service_role` can.
- `shopping_periods.title`: nullable `text`; `shopping_periods_title_check` validated.

## Merges
Both migrations are additive, so the deployed build is unaffected. PR #240 merged earlier. The
merges of #236 and #237 are recorded in the PR history.
