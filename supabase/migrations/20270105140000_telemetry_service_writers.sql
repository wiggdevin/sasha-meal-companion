-- W070, file 1 of 4 (docs/plans/2026-10-10-priority-spec-list.md W070): service-role writers for
-- the two event tables, so the routes stop writing them with the caller's session client.
--
-- `record_food_signals` (20261219090000) and `record_onboarding_events` (20261226090200) are
-- security invoker and store under auth.uid(), so any signed-in user could call them, or insert into
-- the tables directly over PostgREST, past the routes' rate limits. These two `_for` twins take the
-- session-verified user id from the route (lib/server/food-signals.ts, lib/server/onboarding-events.ts,
-- which call them with the admin client after `enforceRateLimit`) and are service_role only. Each
-- applies the same filter as its original, so a batch answers the same counts:
--   * at most 20 events; an event the table would refuse is skipped and counted as rejected;
--   * a repeated client_event_id (stored, or earlier in the same batch) is a duplicate.
-- They are security definer (the owner is not subject to RLS on these tables), so an onboarding
-- batch can use the set-based `on conflict do nothing` the invoker version could not.
--
-- File 4 (20270105140300) revokes the direct inserts and the invoker RPCs from `authenticated`.
--
-- Live-safe: two new functions, no table touched. Order: apply to production BEFORE the W070 code
-- deploys (the code calls these). Down: supabase/migrations/down/20270105140000_telemetry_service_writers.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create function public.record_food_signals_for(p_user_id uuid, p_events jsonb)
  returns table (inserted integer, duplicates integer, rejected integer)
  language plpgsql security definer set search_path = '' as $$
declare
  v_total integer;
  v_eligible integer;
  v_inserted integer;
begin
  if p_user_id is null then
    raise exception 'record_food_signals_for: user id required' using errcode = '22023';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 20 then
    raise exception 'record_food_signals_for: 1 to 20 events' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_events);

  with batch as (
    select e.*
      from jsonb_to_recordset(p_events) as e(client_event_id uuid, slate_id uuid, at timestamptz,
        local_date date, surface text, kind text, occasion text, chosen_key text,
        offered_keys text[], ranking_version text)
  ), eligible as (
    select b.* from batch b
     where b.client_event_id is not null and b.slate_id is not null
       and b.at is not null and b.local_date is not null
       and b.surface in ('swap_sheet', 'plan_sheet', 'suggestion_card')
       and b.kind in ('picked', 'swapped_away', 'not_this', 'added')
       and b.occasion in ('breakfast', 'lunch', 'dinner', 'snack', 'other')
       and b.ranking_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'
       and public.food_signal_slate_valid(b.offered_keys)
       and b.chosen_key = any (b.offered_keys)
       and b.at <= now() + interval '10 minutes'
       and b.at >= now() - interval '14 days'
       and b.local_date between (b.at at time zone 'UTC')::date - 1
                            and (b.at at time zone 'UTC')::date + 1
  ), stored as (
    insert into public.food_signal_events (user_id, client_event_id, slate_id, at, local_date,
      surface, kind, occasion, chosen_key, offered_keys, ranking_version)
    select p_user_id, b.client_event_id, b.slate_id, b.at, b.local_date, b.surface, b.kind,
           b.occasion, b.chosen_key, b.offered_keys, b.ranking_version
      from eligible b
    on conflict (user_id, client_event_id) do nothing
    returning 1
  )
  select (select count(*) from eligible)::integer, (select count(*) from stored)::integer
    into v_eligible, v_inserted;

  return query select v_inserted, v_eligible - v_inserted, v_total - v_eligible;
end $$;

create function public.record_onboarding_events_for(p_user_id uuid, p_events jsonb)
  returns table (inserted integer, duplicates integer, rejected integer)
  language plpgsql security definer set search_path = '' as $$
declare
  v_total integer;
  v_eligible integer;
  v_inserted integer;
begin
  if p_user_id is null then
    raise exception 'record_onboarding_events_for: user id required' using errcode = '22023';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 20 then
    raise exception 'record_onboarding_events_for: 1 to 20 events' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_events);

  with eligible as (
    select b.client_event_id, b.at, b.flow_version, b.kind, b.step, b.question, b.pilot_arm,
           b.duration_ms
      from jsonb_to_recordset(p_events) as b(client_event_id uuid, at timestamptz,
        flow_version text, kind text, step text, question text, pilot_arm text, duration_ms integer)
     where b.client_event_id is not null and b.at is not null
       and b.flow_version in ('onboarding_v2')
       and public.onboarding_event_shape_valid(b.kind, b.step, b.question, b.pilot_arm, b.duration_ms)
       and b.at <= now() + interval '10 minutes'
       and b.at >= now() - interval '14 days'
  ), stored as (
    insert into public.onboarding_events (user_id, client_event_id, at, flow_version, kind, step,
      question, pilot_arm, duration_ms)
    select p_user_id, e.client_event_id, e.at, e.flow_version, e.kind, e.step, e.question,
           e.pilot_arm, e.duration_ms
      from eligible e
    on conflict (user_id, client_event_id) do nothing
    returning 1
  )
  select (select count(*) from eligible)::integer, (select count(*) from stored)::integer
    into v_eligible, v_inserted;

  return query select v_inserted, v_eligible - v_inserted, v_total - v_eligible;
end $$;

revoke all on function public.record_food_signals_for(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_onboarding_events_for(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_food_signals_for(uuid, jsonb) to service_role;
grant execute on function public.record_onboarding_events_for(uuid, jsonb) to service_role;
