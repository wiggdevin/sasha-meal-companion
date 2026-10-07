-- Reverse of 20261218090100_ai_spend_reservations.sql. Deploy the code that no longer reserves
-- first: with the functions gone, every model call's reservation fails and is refused (503,
-- fail closed). The counters are rebuilt from ai_calls on the next day row a reapply creates, so
-- dropping them loses no ledger: ai_calls stays the record of what was spent.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.ai_spend_reserve(uuid, numeric, numeric, numeric, integer);
drop function if exists public.ai_spend_settle(uuid, numeric);
drop function if exists public.ai_spend_sweep(integer);
drop function if exists public._ai_spend_charge(uuid, date, numeric);
drop function if exists public.ai_spend_expired_count();
drop function if exists public._ai_spend_reconcile(uuid);
drop function if exists public._ai_spend_lock_day(uuid, date, boolean);
drop function if exists public._ai_spend_shard(uuid);
drop index if exists public.ai_calls_spend_reservation;
alter table public.ai_calls drop column if exists spend_reservation_id;
drop table if exists public.ai_spend_reservations;
drop table if exists public.ai_spend_user_days;
drop table if exists public.ai_spend_global_days;
