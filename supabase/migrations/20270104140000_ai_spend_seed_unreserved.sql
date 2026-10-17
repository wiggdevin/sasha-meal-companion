-- W068 (spend seed): a new day's spend rows are seeded from `ai_calls` rows that carry no
-- `spend_reservation_id` only.
--
-- A call that reserved before UTC midnight and finished after it has an `ai_calls` row dated the
-- new day, but its cost is charged to the day it reserved on (settle / reconcile). Seeding the new
-- day from every row of that day counted such a call twice. A row that names a reservation is
-- always charged through that reservation, so the seed reads the rows that do not (calls made
-- before reservations existed, ungoverned calls).
--
-- Replaces one function body (20261218090100); no table, grant or signature changes. Live-safe.
-- Down: supabase/migrations/down/20270104140000_ai_spend_seed_unreserved.down.sql.
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
      from public.ai_calls c where c.created_at >= v_start and c.created_at < v_end
        and c.spend_reservation_id is null), 0) else 0 end
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
       and c.spend_reservation_id is null
    on conflict (user_id, day) do nothing;
  end if;
  select u.spent_usd into user_spent from public.ai_spend_user_days u
   where u.user_id = p_user_id and u.day = p_day for update;
  present := present and found;
end $$;
