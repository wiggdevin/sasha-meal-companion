-- One row per user, local date and nutrient code. Coverage is items carrying a value ÷ all items
-- that day (architecture §3.3), so a partial day never reads as a complete one.
create view daily_totals with (security_invoker = true) as
with item_nutrients as (
  select le.user_id, le.local_date, kv.key as code, (kv.value->>'amount')::numeric as amount
    from log_entries le join log_items li on li.entry_id = le.id
    cross join lateral jsonb_each(li.snapshot) kv where le.deleted_at is null),
day_items as (
  select le.user_id, le.local_date, count(*)::int as items_total
    from log_entries le join log_items li on li.entry_id = le.id
   where le.deleted_at is null group by 1, 2)
select n.user_id, n.local_date, n.code as nutrient_code, sum(n.amount) as amount,
       count(n.amount)::int as items_with_value, d.items_total,
       round(count(n.amount)::numeric / nullif(d.items_total, 0), 4) as coverage
  from item_nutrients n
  join day_items d on d.user_id = n.user_id and d.local_date = n.local_date
 group by n.user_id, n.local_date, n.code, d.items_total;
grant select on daily_totals to authenticated;

-- Privileged boundary only (§2.2 rule 3): user-scoped, never granted to authenticated. The MCP
-- boundary has no auth.uid() and binds the tenant with p_user_id.
create or replace function get_daily_totals(p_user_id uuid, p_local_date date)
returns table (nutrient_code text, amount numeric, items_with_value int,
               items_total int, coverage numeric)
language sql security definer set search_path = public, pg_temp as $$
  select nutrient_code, amount, items_with_value, items_total, coverage
    from daily_totals where user_id = p_user_id and local_date = p_local_date;
$$;
revoke execute on function get_daily_totals(uuid, date) from public, authenticated, anon;
grant execute on function get_daily_totals(uuid, date) to service_role;
