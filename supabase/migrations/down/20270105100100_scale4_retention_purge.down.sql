-- Reverse of 20270105100100_scale4_retention_purge.sql. Deploy the code without the
-- /api/jobs/retention-purge cron first: the route fails while the functions are gone. Rows already
-- purged stay purged (restore them from a backup if one is ever needed).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.client_timings_purge(integer);
drop function if exists public.ai_calls_purge(integer);
drop function if exists public.job_runs_purge(integer);
drop function if exists public.recipe_plan_previews_purge(integer);
