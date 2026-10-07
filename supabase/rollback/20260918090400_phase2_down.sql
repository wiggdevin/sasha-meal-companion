-- Rollback for Phase 2. Lives OUTSIDE supabase/migrations on purpose: the CLI applies every file in that folder on
-- db reset / db push, and this one must only ever run by hand — `psql "$DB_URL" -f supabase/rollback/20260918090400_phase2_down.sql`
-- — after reverting the app commit, when Today must fall back to Phase 0 behaviour. Logged data is never dropped: the
-- DRI rows, both indexes and every log_items.snapshot survive.
drop function if exists get_daily_totals(uuid, date);
drop view if exists daily_totals;
drop function if exists compute_item_snapshot(uuid, numeric);
-- _sync_upsert is deliberately left in place: dropping it would take the sync writer with it.
-- Re-apply Lane A's 20260911000600_rpc.sql definition to restore the Phase 0 body.
