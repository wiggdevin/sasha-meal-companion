-- Reverse of 20270105140000_telemetry_service_writers.sql. Reverse 20270105140300 first, or the
-- routes lose their only writer.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.record_food_signals_for(uuid, jsonb);
drop function if exists public.record_onboarding_events_for(uuid, jsonb);
