# W048 step 1 migration applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate").

## Review
GPT-6.1 Sol reviewed `20270105110000_sync_op_receipts` against the live `apply_sync_op` definition
and returned APPLY with no BLOCK findings. It found no migration path that deletes a `change_log`
row and then reuses its op id. Its two WARNs:
- `SET LOCAL` needs a transaction. `scripts/apply-migrations.py` applies each file in its own
  transaction, so the 3 s lock timeout was in effect.
- The down file does not enforce its "no compaction yet" rule. Nothing is pruned yet; any later
  pruning step must check this before a rollback.

## Pre-check
`change_log` had 1,229 rows, 1,223 of them with an op id (1.5 MB). The live `apply_sync_op` held the
replay anchor exactly once.

## Order
Apply before deploy. Applied at 09:16:19 UTC. PR #169 then merged as `2695d93c` at 09:16:35 UTC.
`GET /api/health` on production reported version `2695d93c…` at 09:18:27 UTC.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T091551Z-a01da402.sql` (23,907,410 bytes,
sha256 `dd595565c88adeacd093f699a022e376b3efbad910bc6cece4f04ae0cb850fb4`), taken by `scripts/backup.sh`.

## Applied
The dry run, from `main` with the PR files added, listed only this file. `--commit` applied and
recorded it. A second dry run reported 182 of 182 recorded.

## Verified (read-only SQL)
- `sync_op_receipts` holds 1,223 rows. Every `change_log` op id has a receipt (0 missing).
- The `change_log_op_receipt` trigger exists and is enabled.
- `apply_sync_op` reads `sync_op_receipts` for a replay; the old `change_log` check is gone.
  `authenticated` can execute it; `anon` cannot.
- `authenticated` cannot execute `_sync_op_receipt()`.
- `sync_op_receipts` has RLS on. `authenticated` can select it but cannot insert into it.
