# W044 migrations applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate").

## Review
GPT-6.1 Sol reviewed both files, the down files and the cron route. Round 1 returned BLOCK:
`job_runs_purge` deleted `weekly-proposal` locks after 60 days. An authorized run can name an old
`weekStart`; with its lock gone, that run would reject the account's current pending proposal and
insert nothing. The Mac session fixed it on the PR branch (`e261f375`): the purge keeps every
`weekly-*` lock, and a db test checks that a 400-day-old lock survives. Round 2 returned APPLY and
found no similar path for `oura-pull`, `estimate` or `facet-warm`. CI was green on `e261f375`.

Open WARNs, sent to the coordinator as follow-ups:
- The route's final row counts start after the runner's 285 s stop and can run past
  `maxDuration = 300`; abandoned count requests are not cancelled.
- Accepted previews are purged 7 days after expiry, so a retried accept after that answers 404
  instead of replaying its result. The accepted selections stay.

## Order
1. `20270105100100_scale4_retention_purge` (apply before deploy), applied with
   `scripts/apply-migrations.py --commit` at 10:07:56 UTC.
2. `20270105100000_scale4_indexes_concurrently`: the script wraps files in a transaction, so each
   `CREATE INDEX CONCURRENTLY` ran as its own Management API query. The ledger row (version,
   name, statements) was then inserted the way the script writes it.
3. PR #173 merged as `03c2425b` at 10:08:31 UTC. `GET /api/health` on production reported version
   `03c2425b…` at 10:11:06 UTC.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T100736Z-44772e3b.sql` (24,068,962 bytes,
sha256 `0b6457566b38ab089a4425c28cac4b7299926a43eeecca5203da8d4fc899cbf8`), taken by `scripts/backup.sh`.

## Verified (read-only SQL)
- All four indexes exist, `indisvalid` and `indisready`: `ai_calls_circuit`, `ai_calls_created_at`,
  `log_items_food_ref`, `coach_messages_ai_call` (partial, `ai_call_id is not null`). No index in
  the database is invalid.
- The four purge functions are `SECURITY DEFINER` with `search_path=""`. `service_role` can
  execute them; `authenticated` and `anon` cannot.
- The dry run reported 185 of 185 recorded.

## Row counts before the first run
The first scheduled run is 05:05 UTC on 2026-10-18.

| Table | Rows | Past the window |
|---|---|---|
| `client_timings` | 944 | 0 |
| `ai_calls` | 690 | 0 |
| `job_runs` | 211 | 0 |
| `recipe_plan_previews` | 4 | 4 |

Only foreign key into a purged table: `coach_messages.ai_call_id → ai_calls` (NO ACTION); the
purge skips cited calls.
