-- Calculation audit 2026-10-05, findings 18 and 19: one energy rule per logged item, applied
-- BEFORE the day is summed. `daily_totals` sums each nutrient code on its own, so a day with one
-- reported item (energy_kcal 100) and one calculated-only item (energy_kcal_calc 80) has an
-- energy_kcal row of 100, and a calculated-only day has no energy_kcal amount at all.
--
-- The rule (TS twin: lib/nutrients/energy.ts): per item, the reported `energy_kcal` amount when it
-- is a JSON number >= 0, else the `energy_kcal_calc` amount under the same test, else unknown.
-- Unknown adds nothing to `amount` and lowers `coverage`; it is never counted as 0 kcal.
--
-- One row per user and local date that has at least one live item. `amount` is null when no item
-- that day has usable energy. Idempotent: `create or replace` throughout, grants re-runnable.
create or replace view public.daily_energy with (security_invoker = true) as
with item_energy as (
  select le.user_id, le.local_date,
         case when v.reported >= 0 then v.reported
              when v.calculated >= 0 then v.calculated end as kcal,
         case when v.reported >= 0 then 'reported'
              when v.calculated >= 0 then 'calculated' end as source
    from public.log_entries le
    join public.log_items li on li.entry_id = le.id
    cross join lateral (
      -- CASE guards the cast: a non-number amount (null, string) never reaches ::numeric.
      select case when jsonb_typeof(li.snapshot->'energy_kcal'->'amount') = 'number'
                  then (li.snapshot->'energy_kcal'->>'amount')::numeric end as reported,
             case when jsonb_typeof(li.snapshot->'energy_kcal_calc'->'amount') = 'number'
                  then (li.snapshot->'energy_kcal_calc'->>'amount')::numeric end as calculated
    ) v
   where le.deleted_at is null)
select user_id, local_date,
       sum(kcal) as amount,
       count(kcal)::int as items_with_value,
       count(*)::int as items_total,
       round(count(kcal)::numeric / nullif(count(*), 0), 4) as coverage,
       (count(*) filter (where source = 'reported'))::int as reported_items,
       (count(*) filter (where source = 'calculated'))::int as calculated_items
  from item_energy
 group by user_id, local_date;

grant select on public.daily_energy to authenticated;

-- Privileged boundary only (§2.2 rule 3), the twin of get_daily_totals: user-scoped, never granted
-- to authenticated. The MCP get_day tool and the coach's day totals read the selected energy here.
create or replace function public.get_daily_energy(p_user_id uuid, p_local_date date)
returns table (amount numeric, items_with_value int, items_total int, coverage numeric,
               reported_items int, calculated_items int)
language sql stable security definer set search_path = public, pg_temp as $$
  select amount, items_with_value, items_total, coverage, reported_items, calculated_items
    from public.daily_energy where user_id = p_user_id and local_date = p_local_date;
$$;
revoke execute on function public.get_daily_energy(uuid, date) from public, authenticated, anon;
grant execute on function public.get_daily_energy(uuid, date) to service_role;
