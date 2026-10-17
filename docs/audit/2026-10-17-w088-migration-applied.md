# W088 migration applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate").

## Review
GPT-6.1 Sol first returned BLOCK on the earlier version of `20270104120000_coach_save_turn`. The
thread lock was `FOR UPDATE`. A concurrent direct `coach_messages` insert could take a seq and then
wait on its foreign-key `KEY SHARE` lock on the thread row, while the function waited on that seq,
so the two could deadlock. A WARN noted that the first attempt trusted the seq the caller supplied.
The W088 thread changed the lock to `FOR NO KEY UPDATE`, computed `max(seq)+1` after the lock, and
added database tests. Sol's re-review returned APPLY with no findings.

## Order
The migration only adds `coach_save_turn`, which the new code calls, so it was applied first. PR
#152 then merged as `fc4d85da` at 08:27:49 UTC. `GET /api/health` on production reported version `fc4d85daf3c5…`, `db: ok`, at 08:28:55 UTC.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T082704Z-9a402fdc.sql` (23,889,816 bytes,
sha256 `505f8eb4fd8371ef9cd8e8507617e97b86799a4fb4f13007ec36fee6d22e1ad6`), taken by `scripts/backup.sh`.

## Applied
The dry run, from `main` with the PR file added, listed one pending file. `--commit` applied and
recorded it at 08:27:25 UTC. A second dry run reported 179 of 179 recorded.

## Verified (read-only SQL)
- `coach_save_turn(p_user_id uuid, p_thread_id uuid, p_kind text, p_new_title text, p_rows jsonb,
  p_summary text)` is `SECURITY DEFINER` with `search_path=""`.
- `service_role` can execute it; `authenticated` and `anon` cannot.
- The function body locks the thread with `FOR NO KEY UPDATE`.
