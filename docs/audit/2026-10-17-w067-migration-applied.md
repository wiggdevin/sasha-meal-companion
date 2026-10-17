# W067 migration applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate").

## Review
GPT-6.1 Sol first returned BLOCK on the earlier version of `20270104090000_care_ledger_fixes`:
- `full-week` could be granted for a week that had not closed, when the phone was one date ahead.
- A NULL phone date turned on the date-gated grants.

The #150 thread fixed both (`664162c3`, `0843f807`). Sol's re-review returned APPLY. One WARN was
left: the inherited `search_path = public` on definer functions. It is mitigated because `anon` and
`authenticated` have no CREATE on schema `public` (checked below).

## Order
The new code calls `care_balance`, so the migration was applied first. PR #150 then merged as
`00b057a5` at 07:49:58 UTC. `GET /api/health` on production reported version `00b057a5fac9…`,
`db: ok`, at 07:51:04 UTC.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T074911Z-afbad51a.sql` (23,866,380 bytes,
sha256 `57ebb360c207318202672a928d45d75481efeee2094fb4dc47a57e59a4d151d7`), taken by `scripts/backup.sh`.

## Applied
The dry run, from `main` with the PR file added, listed one pending file. `--commit` applied and
recorded it at 07:49:41 UTC. A second dry run reported 178 of 178 recorded.

## Verified (read-only SQL)
- `care_balance(uuid)` is `SECURITY DEFINER`. `authenticated` can execute it; `anon` cannot.
- `care_accolades_sync(uuid, date, text)` keeps its grants: `authenticated` yes, `anon` no.
- `care_points_sync` keeps its signature `(p_user_id uuid, p_local_date date, p_zone text)`.
- `anon` and `authenticated` cannot CREATE in schema `public`.
