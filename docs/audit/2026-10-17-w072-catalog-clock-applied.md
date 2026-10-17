# W072 migration applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate").

## Review
GPT-6.1 Sol reviewed `20270105110100_recipe_catalog_global_clock` against the live definitions of
the five functions it replaces or patches. The forward file passed every round: the three trigger
bodies match production apart from the intended bump, `recipe_store_preview` keeps its checks, and
the `recipe_accept_preview` anchor occurs once and reverses byte for byte.

All BLOCK findings were in the down file. The Mac session fixed each on the PR branch:
1. A rollback restored the account-only check while unaccepted previews held old values, so a stale
   preview could be accepted. Fix: the down file expires every unaccepted preview first
   (`5583d7d9`).
2. A preview inserted between that sweep and the later table lock escaped it. Fix: lock the
   previews table before the sweep, in a DO block (`f6a84ca3`, `465ae3d7`).
3. Two lock cycles with in-flight store and accept calls. Fix: take `ACCESS EXCLUSIVE NOWAIT` on the
   clock and the previews first; a busy lock fails the whole file with nothing held, to be rerun
   (`1ec62dfa`).

Round 4 returned APPLY. CI was green on `1ec62dfa`.

## Pre-check
10 users, 7 `recipe_plan_state` rows, 4 previews. The `recipe_accept_preview` anchor occurred once.

## Order
Apply before deploy. Applied at 09:49:26 UTC. PR #178 then merged as `c02ebd88` at 09:49:39 UTC.
`GET /api/health` on production reported version `c02ebd88…` at 09:50:56 UTC. The catalog clock
was still at rev 0 then, so no old-build preview answered "Preview again" in the window.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T094907Z-904c25f0.sql` (24,054,092 bytes,
sha256 `b6150f6c564a8765cff2e94d338007bb73f9cb352cd04fdb431211d1696b38e5`), taken by `scripts/backup.sh`.

## Applied
The dry run, from `main` with the PR file added, listed only this file. `--commit` applied and
recorded it. A second dry run reported 183 of 183 recorded.

## Verified (read-only SQL)
- `recipe_catalog_clock` holds one row, `id 1`, `rev 0`. RLS is on and forced. `authenticated` can
  select it but cannot update it; `anon` cannot select it.
- `recipe_plan_previews.catalog_rev` exists.
- `recipe_accept_preview` and `recipe_store_preview` read the clock. `service_role` can still
  execute `recipe_store_preview`.
- `recipe_plan_bump_global_state` calls `_recipe_catalog_bump` and no longer updates every
  account's `recipe_plan_state`. `authenticated` cannot execute `_recipe_catalog_bump`.
