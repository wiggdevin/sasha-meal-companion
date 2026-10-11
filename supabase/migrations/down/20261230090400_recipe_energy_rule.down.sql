-- Reverse of 20261230090400_recipe_energy_rule.sql: the recipe branch of _sync_upsert first, then
-- the helper it called. No data changes either way: recipe revisions written under the rule keep
-- their stored numbers (a revision is immutable); the next save sums energy per code again.
do $migration$
declare
  definition text;
  patched text := $a$        select kv.key as code, (kv.value->>'amount')::numeric as amount
          from per_item cross join lateral jsonb_each(per_item.snap) kv
         where kv.key not in ('energy_kcal', 'energy_kcal_calc')
        union all
        -- W004 (audit A008): one energy per item by the one energy rule, before the sum.
        select 'energy_kcal', public._snapshot_energy_kcal(per_item.snap)
          from per_item
         where per_item.snap ? 'energy_kcal' or per_item.snap ? 'energy_kcal_calc'),$a$;
  original text := $a$        select kv.key as code, (kv.value->>'amount')::numeric as amount
          from per_item cross join lateral jsonb_each(per_item.snap) kv),$a$;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('_snapshot_energy_kcal' in definition) = 0 then return; end if;
  if position(patched in definition) = 0 then
    raise exception 'recipe_energy_rule down (_sync_upsert): the patched recipe block is not as written; refusing a guess';
  end if;
  execute replace(definition, patched, original);
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;

drop function if exists public._snapshot_energy_kcal(jsonb);
