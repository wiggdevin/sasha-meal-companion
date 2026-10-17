# OD01, W068 and W074 migrations applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate"). Second-model review: GPT-6.1 Sol read the four files against
`20261218090100_ai_spend_reservations` and returned APPLY, with no BLOCK findings. Its one WARN was
the short `ACCESS EXCLUSIVE` lock in two files; the 3 s lock timeout did not fire.

## Order
#136 requires apply-before-merge; #148 and #147 are safe either way. All four files were applied
first, then the PRs merged:

| PR | Merge | Merged (UTC) |
|---|---|---|
| #136 OD01 background spend ceiling | `cd2582c4` | 07:24:19 |
| #148 W068 spend seed | `a0cbd6fd` | 07:24:39 |
| #147 W074 goal rate check | `de4b6c15` | 07:24:56 |

`GET /api/health` on production reported version `de4b6c1546a5…`, `db: ok`, at 07:26:07 UTC.
Before the merges, the old build (`6728ca3c`) also reported `db: ok` after the apply: the
five-argument `ai_spend_reserve` stays and calls the new split as an interactive reservation.

## Pre-checks (read-only SQL)
- `target_profiles`: 65 rows, 0 with a goal rate outside the presets (the W074 validate gate).
- `ai_spend_reservations`: 73 rows, 0 open holds.
- No migration after `20261218090100` redefines `_ai_spend_lock_day` or `ai_spend_reserve`.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T072309Z-60660198.sql` (23,848,876 bytes,
sha256 `aee15089bcfe0796dc0ecea95f1eabcd056d862776dfc9ea8fabe34fa1b22429`), taken by `scripts/backup.sh`.

## Applied
From a checkout of `main` (`6728ca3c`) with the four PR files added, the dry run listed exactly
these four; `--commit` applied and recorded each in its own transaction at 07:23:42 UTC:
- `20270103090000_ai_spend_background_split` (#136)
- `20270104100000_target_profiles_goal_rate_check` (#147)
- `20270104100100_target_profiles_goal_rate_check_validate` (#147)
- `20270104140000_ai_spend_seed_unreserved` (#148)

A second dry run reported 177 of 177 recorded, nothing pending.

## Verified (read-only SQL)
- `ai_spend_reservations.background` exists.
- `ai_spend_reserve_split` is `SECURITY DEFINER` with `search_path=""`; `service_role` can execute
  it, `authenticated` cannot.
- `authenticated` still cannot execute `ai_spend_reserve` or `_ai_spend_lock_day`.
- `_ai_spend_lock_day` now seeds only from rows with `spend_reservation_id is null`.
- `target_profiles_goal_rate_bp_week_check` is validated.
