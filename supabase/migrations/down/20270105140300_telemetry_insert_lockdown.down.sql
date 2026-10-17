-- Reverse of 20270105140300_telemetry_insert_lockdown.sql: the grants, policies and RPC execute
-- rights the three original migrations gave `authenticated`.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

grant insert on table public.client_timings to authenticated;
create policy client_timings_insert on public.client_timings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

grant insert (id, user_id, client_event_id, slate_id, at, local_date, surface, kind, occasion,
              chosen_key, offered_keys, ranking_version)
  on table public.food_signal_events to authenticated;
create policy food_signal_events_insert on public.food_signal_events for insert to authenticated
  with check (user_id = (select auth.uid()));

grant insert (id, user_id, client_event_id, at, flow_version, kind, step, question, pilot_arm,
              duration_ms)
  on table public.onboarding_events to authenticated;
create policy onboarding_events_insert on public.onboarding_events for insert to authenticated
  with check (user_id = (select auth.uid()));

grant execute on function public.record_food_signals(jsonb) to authenticated;
grant execute on function public.record_onboarding_events(jsonb) to authenticated;
