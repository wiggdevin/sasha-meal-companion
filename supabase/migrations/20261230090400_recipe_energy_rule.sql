-- W004 (audit 2026-10-10, A008): a recipe's energy follows the one energy rule. The recipe branch
-- of _sync_upsert summed `energy_kcal` and `energy_kcal_calc` as two independent codes and judged
-- coverage on `energy_kcal` alone, so an ingredient whose only energy is the Atwater-calculated
-- figure (FDC Foundation without a 1008 row, every OFF/FDC-branded row without a label energy)
-- counted as having none: ingredient A (100 kcal reported) + B (80 kcal calculated only) stored a
-- recipe `energy_kcal` of 100, and a logged serving counted 100 instead of 180.
--
-- Now each ingredient's snapshot gets ONE energy before the sum, by the rule the `daily_energy`
-- view (20261210090000) and lib/nutrients/energy.ts apply: the reported amount when it is a JSON
-- number >= 0, else the calculated amount under the same test, else unknown (null, never 0). The
-- selected sum is stored as the recipe's `energy_kcal` and counts toward its coverage; no separate
-- `energy_kcal_calc` sum is kept. The TS twin is lib/recipes/nutrients.ts (computeRecipeNutrients);
-- tests/migrations/recipe-energy-rule-db.test.ts proves both on one shared fixture.
--
-- Existing recipe revisions are not recomputed: a revision is immutable, and log items keep the
-- snapshot they were written with. The next save of a recipe writes a revision under this rule.
--
-- Patches only the recipe branch of _sync_upsert by anchor (the mascot / cuisines pattern,
-- 20261225090000), refusing a partial or ambiguous patch. Live-safe: CREATE FUNCTION and CREATE OR
-- REPLACE FUNCTION take no table lock. Order: apply to production BEFORE the W004 code merges (the
-- phone's provisional recipe numbers then match what the server stores from the first save).
-- Down: supabase/migrations/down/20261230090400_recipe_energy_rule.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- One item snapshot's energy by the one energy rule. CASE guards each cast, so a non-number amount
-- (null, a string) never reaches ::numeric (the daily_energy view's own form).
create or replace function public._snapshot_energy_kcal(p_snap jsonb)
returns numeric
language sql immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select case when v.reported >= 0 then v.reported
              when v.calculated >= 0 then v.calculated end
    from (select case when jsonb_typeof(p_snap->'energy_kcal'->'amount') = 'number'
                      then (p_snap->'energy_kcal'->>'amount')::numeric end as reported,
                 case when jsonb_typeof(p_snap->'energy_kcal_calc'->'amount') = 'number'
                      then (p_snap->'energy_kcal_calc'->>'amount')::numeric end as calculated) v
$fn$;
revoke all on function public._snapshot_energy_kcal(jsonb) from public, anon, authenticated;
grant execute on function public._snapshot_energy_kcal(jsonb) to service_role;
comment on function public._snapshot_energy_kcal(jsonb) is
  'W004: one item snapshot''s energy by the one energy rule (reported, else calculated, else '
  'null). SQL twin of lib/nutrients/energy.ts itemKcal; the recipe sum in _sync_upsert reads it.';

do $migration$
declare
  definition text;
  froms text[] := array[
    $a$        select kv.key as code, (kv.value->>'amount')::numeric as amount
          from per_item cross join lateral jsonb_each(per_item.snap) kv),$a$];
  tos text[] := array[
    $a$        select kv.key as code, (kv.value->>'amount')::numeric as amount
          from per_item cross join lateral jsonb_each(per_item.snap) kv
         where kv.key not in ('energy_kcal', 'energy_kcal_calc')
        union all
        -- W004 (audit A008): one energy per item by the one energy rule, before the sum.
        select 'energy_kcal', public._snapshot_energy_kcal(per_item.snap)
          from per_item
         where per_item.snap ? 'energy_kcal' or per_item.snap ? 'energy_kcal_calc'),$a$];
  i integer;
  occurrences integer;
  done_count integer := 0;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  for i in 1 .. array_length(tos, 1) loop
    if (length(definition) - length(replace(definition, tos[i], ''))) / length(tos[i]) = 1 then
      done_count := done_count + 1;
    end if;
  end loop;
  if done_count = array_length(tos, 1) then return; end if;
  if done_count > 0 then
    raise exception 'recipe_energy_rule (_sync_upsert): % of % parts already patched; refusing a partial function',
      done_count, array_length(tos, 1);
  end if;
  for i in 1 .. array_length(froms, 1) loop
    occurrences := (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]);
    if occurrences <> 1 then
      raise exception 'recipe_energy_rule (_sync_upsert): anchor % occurs % times, expected once', i, occurrences;
    end if;
  end loop;
  for i in 1 .. array_length(froms, 1) loop
    definition := replace(definition, froms[i], tos[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;
