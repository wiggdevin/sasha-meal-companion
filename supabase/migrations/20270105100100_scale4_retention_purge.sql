-- W044 (scale step 4): bounded purges for four tables that only ever grew. Each function deletes
-- at most p_max rows past its retention window (1 to 20,000; null means 5,000), oldest first,
-- skipping rows another transaction holds (SKIP LOCKED), and returns how many it deleted. Modelled
-- on food_signal_events_purge (20261219090000). The /api/jobs/retention-purge cron calls them in
-- passes until a pass deletes less than a full batch.
--
-- Retention windows:
--   * client_timings, 90 days by created_at (the server's clock; `at` comes from the phone).
--     `pnpm timings` reads 7 days by default.
--   * ai_calls, 90 days by created_at, and never a row that
--       - names an UNSETTLED hold in ai_spend_reservations (spend_reservation_id): ai_spend_sweep
--         charges an expired hold the cost of the ai_calls rows that name it, so those rows stay
--         until the hold is settled or reconciled. A hold already pruned is not open.
--       - a coach message cites (coach_messages.ai_call_id, a foreign key with no cascade): that
--         is the stored proof a reply came from a model, kept as long as the message.
--     Most coach-turn calls are cited, so this purge mostly removes capture, plan, intent and
--     background calls; the cited ones go when their thread or account is deleted.
--     The spend caps read their own day tables (40 days), the circuit breaker minutes, and the
--     capture duplicate probe hours, so nothing reads ai_calls past 90 days.
--   * job_runs, 60 days by started_at, except the week-keyed weekly-* locks (kept: an authorized
--     run can name an old week). Other lock keys are the current date or week (oura-pull,
--     estimate, facet-warm, weekly-proposal, weekly-review and its `#retry` key), so a lock that
--     old is never claimed again.
--   * recipe_plan_previews, 7 days after expires_at (a preview lives at most 30 minutes). An
--     accept retried after that answers 404 instead of replaying its stored result.
--
-- service_role only: no API role can call them. Live-safe: four new functions, no table change.
-- Apply order: BEFORE the code that calls them deploys (the cron fails without them).
-- Down: supabase/migrations/down/20270105100100_scale4_retention_purge.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create function public.client_timings_purge(p_max integer default 5000) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  -- id is an identity column, so its order is insertion order: the primary key walks oldest first.
  delete from public.client_timings t
   where t.id = any (array(
     select x.id from public.client_timings x
      where x.created_at < now() - interval '90 days'
      order by x.id
      limit greatest(1, least(coalesce(p_max, 5000), 20000))
      for update skip locked));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

create function public.ai_calls_purge(p_max integer default 5000) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  delete from public.ai_calls c
   where c.id = any (array(
     select x.id from public.ai_calls x
      where x.created_at < now() - interval '90 days'
        and not exists (select 1 from public.ai_spend_reservations r
                         where r.id = x.spend_reservation_id and r.settled_at is null)
        and not exists (select 1 from public.coach_messages m where m.ai_call_id = x.id)
      order by x.created_at
      limit greatest(1, least(coalesce(p_max, 5000), 20000))
      for update of x skip locked));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

create function public.job_runs_purge(p_max integer default 5000) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  delete from public.job_runs j
   where j.ctid = any (array(
     select x.ctid from public.job_runs x
      where x.started_at < now() - interval '60 days'
        -- Week-keyed locks stay: an authorized run can name an old weekStart, and with its lock
        -- gone weekly-proposal would run again and reject the current pending proposal.
        and x.job not like 'weekly-%'
      order by x.started_at
      limit greatest(1, least(coalesce(p_max, 5000), 20000))
      for update skip locked));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

create function public.recipe_plan_previews_purge(p_max integer default 5000) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  delete from public.recipe_plan_previews p
   where p.id = any (array(
     select x.id from public.recipe_plan_previews x
      where x.expires_at < now() - interval '7 days'
      order by x.expires_at
      limit greatest(1, least(coalesce(p_max, 5000), 20000))
      for update skip locked));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.client_timings_purge(integer) from public, anon, authenticated;
revoke all on function public.ai_calls_purge(integer) from public, anon, authenticated;
revoke all on function public.job_runs_purge(integer) from public, anon, authenticated;
revoke all on function public.recipe_plan_previews_purge(integer) from public, anon, authenticated;
grant execute on function public.client_timings_purge(integer) to service_role;
grant execute on function public.ai_calls_purge(integer) to service_role;
grant execute on function public.job_runs_purge(integer) to service_role;
grant execute on function public.recipe_plan_previews_purge(integer) to service_role;
