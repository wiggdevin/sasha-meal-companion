-- Scale slice S2: covering indexes for user_id foreign keys the Supabase advisor flagged
-- (unindexed_foreign_keys). Each one serves an account delete's ON DELETE CASCADE (without it the
-- cascade scans the whole table per deleted account) and the per-user reads on that table.
--
-- Checked on a migrated stack before writing: none of these tables has an index whose first
-- column is user_id (job_runs' primary key leads with `job`, target_profiles' unique key with
-- `id`), so each index below is new coverage, not a duplicate.
--
-- Plain CREATE INDEX, not CONCURRENTLY: every table is tiny today (a handful of accounts), so the
-- brief SHARE lock is milliseconds, and CONCURRENTLY cannot run inside the migration's
-- transaction. Revisit CONCURRENTLY (outside a transaction) for any index added once a table is
-- large. IF NOT EXISTS keeps a re-run harmless.
-- Down: supabase/migrations/down/20261218090200_user_id_fk_indexes.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create index if not exists api_tokens_user_id on public.api_tokens (user_id);
create index if not exists client_timings_user_id on public.client_timings (user_id);
create index if not exists favorites_meals_user_id on public.favorites_meals (user_id);
create index if not exists ingest_events_user_id on public.ingest_events (user_id);
create index if not exists job_runs_user_id on public.job_runs (user_id);
create index if not exists media_objects_user_id on public.media_objects (user_id);
create index if not exists oauth_states_user_id on public.oauth_states (user_id);
create index if not exists recipes_user_id on public.recipes (user_id);
create index if not exists target_profiles_user_id on public.target_profiles (user_id);
