# W018 migration applied to production, 2026-10-12

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-11 ("W018 after deploy").

## Order
PR #90 merged as `6433237c`; `GET /api/health` on production reported version `6433237ca0ab…` at
00:13 UTC. The migration was applied after that, as its header requires (the deployed build writes
assistant coach rows with the service role).

## Backup
`~/Backups/supabase/meal-companion/2026-10-12T001316Z-c7845794.sql` (23,815,327 bytes,
sha256 `1d88a96f1fd4225ee743b19196a206b3a68e4c4973e8c585c1bd933ecea57081`), taken by `scripts/backup.sh`.

## Applied
Dry run listed one pending file; `--commit` applied and recorded it:
- `20261231170000_server_owned_tables` (applied after 20261231180000–20261231200000; the runner applies by ledger, not position)

A second dry run lists nothing pending.

## Verified (read-only SQL and logs)
- `authenticated` table grants: `target_profiles`, `change_log`, `change_seq`, `health_sources`,
  `user_settings` SELECT only; `coach_messages` SELECT, INSERT, DELETE.
- Postgres logs from 00:10 UTC: no "permission denied" or row-level security errors.
