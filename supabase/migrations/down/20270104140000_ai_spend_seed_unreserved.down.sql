-- Down for 20270104140000_ai_spend_seed_unreserved: the seed reads every ai_calls row of the day
-- again (the 20261218090100 body), which counts a call that reserved before UTC midnight twice.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public._ai_spend_lock_day(p_user_id uuid, p_day date, p_create boolean,
  out user_spent numeric, out present boolean)
  language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := p_day::timestamp at time zone 'utc';
  v_end timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  if p_create and not exists (select 1 from public.ai_spend_global_days where day = p_day) then
    insert into public.ai_spend_global_days (day, shard, spent_usd)
    select p_day, g.shard, case when g.shard = 0 then coalesce((select sum(greatest(c.cost_estimate, 0))
      from public.ai_calls c where c.created_at >= v_start and c.created_at < v_end), 0) else 0 end
      from generate_series(0, 15) g(shard)
    on conflict (day, shard) do nothing;
  end if;
  perform 1 from public.ai_spend_global_days
   where day = p_day and shard = public._ai_spend_shard(p_user_id) for update;
  present := found;
  if p_create and not exists (select 1 from public.ai_spend_user_days
                               where user_id = p_user_id and day = p_day) then
    insert into public.ai_spend_user_days (user_id, day, spent_usd)
    select p_user_id, p_day, coalesce(sum(greatest(c.cost_estimate, 0)), 0)
      from public.ai_calls c
     where c.user_id = p_user_id and c.created_at >= v_start and c.created_at < v_end
    on conflict (user_id, day) do nothing;
  end if;
  select u.spent_usd into user_spent from public.ai_spend_user_days u
   where u.user_id = p_user_id and u.day = p_day for update;
  present := present and found;
end $$;
