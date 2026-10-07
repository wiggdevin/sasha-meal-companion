-- Reverse of 20261218090200_user_id_fk_indexes.sql: drops the nine user_id indexes. Nothing
-- depends on them; account deletes and per-user reads go back to sequential scans.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop index if exists public.api_tokens_user_id;
drop index if exists public.client_timings_user_id;
drop index if exists public.favorites_meals_user_id;
drop index if exists public.ingest_events_user_id;
drop index if exists public.job_runs_user_id;
drop index if exists public.media_objects_user_id;
drop index if exists public.oauth_states_user_id;
drop index if exists public.recipes_user_id;
drop index if exists public.target_profiles_user_id;
