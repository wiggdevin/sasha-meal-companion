-- Reverse of 20261226090200_onboarding_events.sql. Deploy the code that no longer calls
-- record_onboarding_events or onboarding_events_purge first: POST /api/onboarding/events answers
-- 202 when the insert fails, and the purge cron fails until it is removed from vercel.json. These
-- rows are W15 analytics inputs, not the user's record (no answer content ever lived here), so
-- dropping them loses only the ablation report's data, never anything else.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.record_onboarding_events(jsonb);
drop function if exists public.onboarding_events_purge(integer);
drop table if exists public.onboarding_events;
drop function if exists public.onboarding_event_shape_valid(text, text, text, text, integer);
