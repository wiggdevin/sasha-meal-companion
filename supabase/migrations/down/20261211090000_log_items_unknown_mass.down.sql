-- Reverse of 20261211090000_log_items_unknown_mass.sql. Refuses while any item has an unknown
-- mass: putting NOT NULL back would need a mass nobody knows.
do $refuse$
begin
  if exists (select 1 from public.log_items where grams is null) then
    raise exception 'log_items_unknown_mass down: log_items holds items with an unknown mass; delete or weigh them first'
      using errcode = '55000';
  end if;
end;
$refuse$;

do $migration$
declare
  definition text;
  pairs text[][] := array[
    ['             case when i.grams is null then
                    case when i.per_unit is not null
                           then compute_unit_snapshot(i.per_unit, i.qty)
                         when i.id is not null
                           and v_prior ? i.id::text
                           and v_prior->(i.id::text)->>''grams'' is null
                           and (v_prior->(i.id::text)->>''food_ref_id'')::uuid = i.food_ref_id
                           then recompute_unit_snapshot(v_prior->(i.id::text)->''snapshot'', i.qty)
                         else ''{}''::jsonb end
                  when not v_force
                   and i.id is not null
                   and v_prior ? i.id::text
                   and (v_prior->(i.id::text)->>''grams'')::numeric = i.grams',
     '             case when not v_force
                   and i.id is not null
                   and v_prior ? i.id::text
                   and (v_prior->(i.id::text)->>''grams'')::numeric = i.grams'],
    ['             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric, per_unit jsonb);',
     '             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric);']];
  i integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('compute_unit_snapshot' in definition) = 0 then return; end if;
  for i in 1 .. array_length(pairs, 1) loop
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;

create or replace function public.compute_item_snapshot(p_food_ref_id uuid, p_grams numeric)
returns jsonb language sql stable security invoker as $$
  with ref as (select * from food_refs where id = p_food_ref_id),
  rev as (select r.id, v.source, v.version_label from catalog_food_revisions r
            join catalog_versions v on v.id = r.catalog_version_id
            join ref on ref.catalog_food_id = r.catalog_food_id where r.is_active),
  catalog_vals as (select n.nutrient_code as code, n.amount_per_100g as per100, c.unit,
           rev.source, rev.version_label, rev.id as revision_id from rev
      join catalog_food_nutrients n on n.food_revision_id = rev.id
      join catalog_nutrients c on c.code = n.nutrient_code),
  user_vals as (select kv.key as code, nullif(kv.value, 'null'::jsonb)::numeric as per100, c.unit,
           'user'::text as source, uf.rev::text as version_label, null::bigint as revision_id
      from ref join user_foods uf on uf.id = ref.user_food_id
      cross join lateral jsonb_each(uf.per_100g) kv join catalog_nutrients c on c.code = kv.key),
  vals as (select * from catalog_vals union all select * from user_vals)
  select coalesce(jsonb_object_agg(code, jsonb_build_object(
           'amount', case when per100 is null then null else round(per100*p_grams/100.0, 4) end,
           'unit', unit, 'basis', 'per_100g', 'source', source,
           'source_version', version_label, 'revision_id', revision_id)), '{}'::jsonb) from vals;
$$;

drop trigger if exists log_items_unknown_mass_own_food on public.log_items;
drop function if exists public.log_items_unknown_mass_own_food();
drop function if exists public.recompute_unit_snapshot(jsonb, numeric);
drop function if exists public.compute_unit_snapshot(jsonb, numeric);
alter table public.log_items drop constraint if exists log_items_unknown_mass_is_unit;
alter table public.log_items alter column grams set not null;
