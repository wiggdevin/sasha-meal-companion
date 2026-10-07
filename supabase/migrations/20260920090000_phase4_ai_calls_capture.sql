-- Phase 4, contracts §5 ("Reconciled ai_calls"). No `outcome` column: Phase 0 already shipped
-- `status`, and the adapter already writes it. This widens the two-value Phase 0 check to the six
-- AiStatus values and adds the two things propose needs — an index that makes the 10-minute
-- duplicate probe cheap, and the per-local-day counter the caps read.
alter table ai_calls drop constraint if exists ai_calls_status_check;
alter table ai_calls add constraint ai_calls_status_check
  check (status in ('ok','schema_invalid','provider_error','timeout','blocked','error'));

-- Idempotency is a ROUTE check, not a unique index: the window is 10 minutes and no index can
-- express that. This is the index that probe reads; `created_at desc` lets it stop at the first row.
create index if not exists ai_calls_idem
  on ai_calls (user_id, purpose, input_hash, created_at desc) where status = 'ok';

-- security definer so the count is exact even though the caller's RLS already limits it to their
-- own rows: the route reads it through the admin client only, so `p_user_id` is never a free
-- parameter an authenticated caller could point at someone else.
create or replace function ai_calls_today(p_user_id uuid, p_tz text) returns integer
  language sql stable security definer set search_path = public as $$
  select count(*)::integer from ai_calls
   where user_id = p_user_id and status = 'ok'
     and (created_at at time zone p_tz)::date = (now() at time zone p_tz)::date;
$$;
revoke execute on function ai_calls_today(uuid, text) from anon, public;
revoke execute on function ai_calls_today(uuid, text) from authenticated;
grant execute on function ai_calls_today(uuid, text) to service_role;
