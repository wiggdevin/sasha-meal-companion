-- W070, file 4 of 4: `authenticated` can no longer write the three telemetry and event tables.
--
-- The routes were the only quota (rate limits, batch caps), but a signed-in user could insert into
-- `client_timings`, `food_signal_events` and `onboarding_events` directly over PostgREST, or call
-- the invoker batch RPCs, as often as they liked. From this file on the only writers are
-- service_role: POST /api/timings (lib/server/client-timings.ts), POST /api/foods/signals
-- (`record_food_signals_for`) and POST /api/onboarding/events (`record_onboarding_events_for`),
-- each after its rate limit. A direct insert answers 42501.
--
--   * Table INSERT grants are revoked (a table-level revoke also revokes the column grants; the
--     check at the end proves none is left) and the three insert policies are dropped.
--   * `record_food_signals(jsonb)` and `record_onboarding_events(jsonb)` are kept (an older build
--     names them) but no longer executable by `authenticated`.
--   * `authenticated` keeps its owner SELECT on food_signal_events; client_timings and
--     onboarding_events are left with no policy for it at all, so it has no operation on either.
--
-- Order: apply to production AFTER the W070 code deploys, never before. An older build writes with
-- the session client and gets 42501 once this is applied; its routes still answer 202, so the cost
-- is lost measurements, never a failed tap. Needs 20270105140000 first. Rolling the code back after
-- this is applied has the same cost: run the down file first, then revert the code.
-- Down: supabase/migrations/down/20270105140300_telemetry_insert_lockdown.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

revoke insert on table public.client_timings from authenticated;
revoke insert on table public.food_signal_events from authenticated;
revoke insert on table public.onboarding_events from authenticated;

drop policy if exists client_timings_insert on public.client_timings;
drop policy if exists food_signal_events_insert on public.food_signal_events;
drop policy if exists onboarding_events_insert on public.onboarding_events;

revoke execute on function public.record_food_signals(jsonb) from public, anon, authenticated;
revoke execute on function public.record_onboarding_events(jsonb) from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['client_timings', 'food_signal_events', 'onboarding_events'] loop
    if has_any_column_privilege('authenticated', format('public.%I', t), 'INSERT')
       or has_any_column_privilege('anon', format('public.%I', t), 'INSERT') then
      raise exception '20270105140300: an API role can still insert into %', t;
    end if;
  end loop;
end $$;
