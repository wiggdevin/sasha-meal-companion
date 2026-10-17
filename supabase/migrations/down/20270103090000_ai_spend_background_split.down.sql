-- Reverse of 20270103090000_ai_spend_background_split.sql. Deploy the code that calls the old
-- five-argument ai_spend_reserve first: with ai_spend_reserve_split gone, the newer build's every
-- model call fails its reservation and is refused (503, fail closed). Background calls are then
-- checked against the account cap and the global ceiling only, as before OD01.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public.ai_spend_reserve(
  p_user_id uuid, p_amount_usd numeric, p_user_cap_usd numeric, p_global_cap_usd numeric,
  p_ttl_seconds integer default 300)
  returns table (reservation_id uuid, allowed boolean, reason text,
                 user_committed_usd numeric, global_committed_usd numeric)
  language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_user_spent numeric;
  v_global_spent numeric;
  v_user numeric;
  v_global numeric;
  v_expired uuid;
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'ai_spend_reserve: user required' using errcode = '22023';
  end if;
  if p_amount_usd is null or p_amount_usd < 0 or p_amount_usd = 'NaN'::numeric
     or p_user_cap_usd is null or p_user_cap_usd = 'NaN'::numeric
     or p_global_cap_usd is null or p_global_cap_usd = 'NaN'::numeric then
    raise exception 'ai_spend_reserve: amount and caps must be numbers, amount >= 0'
      using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 30 and 900 then
    raise exception 'ai_spend_reserve: ttl 30-900 s' using errcode = '22023';
  end if;

  perform public._ai_spend_lock_day(p_user_id, v_day, true);
  for v_expired in
    select r.id from public.ai_spend_reservations r
     where r.user_id = p_user_id and r.day = v_day and r.settled_at is null and r.expires_at < now()
     order by r.expires_at limit 100
  loop
    perform public._ai_spend_reconcile(v_expired);
  end loop;

  select u.spent_usd,
         u.spent_usd + coalesce((select sum(r.amount_usd) from public.ai_spend_reservations r
           where r.user_id = p_user_id and r.day = v_day and r.settled_at is null), 0),
         (select coalesce(sum(g.spent_usd), 0) from public.ai_spend_global_days g where g.day = v_day),
         (select coalesce(sum(g.spent_usd), 0) from public.ai_spend_global_days g where g.day = v_day)
           + coalesce((select sum(r.amount_usd) from public.ai_spend_reservations r
               where r.day = v_day and r.settled_at is null), 0)
    into v_user_spent, v_user, v_global_spent, v_global
    from public.ai_spend_user_days u where u.user_id = p_user_id and u.day = v_day;

  if p_user_cap_usd <= 0 or v_user_spent >= p_user_cap_usd
     or v_user + p_amount_usd > p_user_cap_usd then
    return query select null::uuid, false, 'user_cap'::text, v_user, v_global;
    return;
  end if;
  if p_global_cap_usd <= 0 or v_global_spent >= p_global_cap_usd
     or v_global + p_amount_usd > p_global_cap_usd then
    return query select null::uuid, false, 'global_cap'::text, v_user, v_global;
    return;
  end if;

  insert into public.ai_spend_reservations (user_id, day, amount_usd, expires_at)
  values (p_user_id, v_day, p_amount_usd, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return query select v_id, true, null::text, v_user + p_amount_usd, v_global + p_amount_usd;
end $$;
revoke all on function public.ai_spend_reserve(uuid, numeric, numeric, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.ai_spend_reserve(uuid, numeric, numeric, numeric, integer)
  to service_role;

drop function if exists public.ai_spend_reserve_split(uuid, numeric, numeric, numeric, integer,
  boolean, numeric, numeric);
drop index if exists public.ai_spend_reservations_background_day;
alter table public.ai_spend_reservations drop column if exists background;
