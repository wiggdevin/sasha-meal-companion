-- Reverse of 20261219090000_food_signal_events.sql. Deploy the code that no longer calls
-- record_food_signals or food_signal_events_purge first: POST /api/foods/signals answers 202 when
-- the insert fails, and the purge cron fails until it is removed. The events are 180-day ranking
-- signals, not the user's record (that is their logs and diet_prefs.taste), so dropping them loses
-- only learning input.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.record_food_signals(jsonb);
drop function if exists public.food_signal_events_purge(integer);
drop table if exists public.food_signal_events;
drop function if exists public.food_signal_slate_valid(text[]);
