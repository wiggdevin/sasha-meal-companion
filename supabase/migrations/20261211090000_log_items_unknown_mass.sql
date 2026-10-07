-- t17 gap 1 (calc audit 2026-10-05): a unit logged for a food with no known unit weight.
--
-- The mass is unknown, so it is stored as unknown: log_items.grams is null, never a guessed mass
-- and never 0. qty and unit are then the whole amount. The nutrients are the account's own
-- per-unit numbers × qty, sent with the item as `per_unit` ({ "<nutrient code>": amount per one
-- unit }); with none, the snapshot is '{}' — unknown, which the energy rule (daily_energy) already
-- reads as "adds nothing and lowers coverage".
--
-- A catalog item always has grams: a null mass is refused on any item that names a catalog
-- revision or portion.

alter table public.log_items alter column grams drop not null;
alter table public.log_items drop constraint if exists log_items_unknown_mass_is_unit;
alter table public.log_items add constraint log_items_unknown_mass_is_unit
  check (grams is not null or (food_revision_id is null and portion_id is null));

-- An unknown mass belongs only to the account's OWN food (food_refs.kind = 'user'): a catalog food
-- always has a mass and its own numbers, and per_unit on one would let a write state any calories
-- (t17 round 3). Checked on every write that leaves grams null, whichever path made it.
create or replace function public.log_items_unknown_mass_own_food() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from food_refs r where r.id = new.food_ref_id and r.kind = 'user') then
    raise exception 'log_items_unknown_mass: an unknown mass is only for the account''s own food'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.log_items_unknown_mass_own_food() from public, anon, authenticated;
drop trigger if exists log_items_unknown_mass_own_food on public.log_items;
create trigger log_items_unknown_mass_own_food
  before insert or update of grams, food_ref_id on public.log_items
  for each row when (new.grams is null)
  execute function public.log_items_unknown_mass_own_food();

-- The per-100 g snapshot has no grams to scale by when the mass is unknown: nothing measured.
-- The installed body, with one guard (`and p_grams is not null`) and nothing else changed.
create or replace function public.compute_item_snapshot(p_food_ref_id uuid, p_grams numeric)
returns jsonb language sql stable security invoker as $$
  with ref as (select * from food_refs where id = p_food_ref_id and p_grams is not null),
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
grant execute on function public.compute_item_snapshot(uuid, numeric) to authenticated;
grant execute on function public.compute_item_snapshot(uuid, numeric) to service_role;

-- per_unit × qty, for an item whose mass is unknown. Only known nutrient codes with a JSON number
-- >= 0 count; anything else is ignored (no row), so a malformed map is unknown, never 0. Each entry
-- keeps the EXACT per-unit number it came from (`per_unit`, unrounded), and `amount` is rounded once,
-- here, at output: a later count edit recomputes from `per_unit`, never from a rounded amount.
create or replace function public.compute_unit_snapshot(p_per_unit jsonb, p_qty numeric)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_object_agg(kv.key, jsonb_build_object(
           'amount', round((kv.value)::numeric * p_qty, 4),
           'per_unit', (kv.value)::numeric,
           'unit', c.unit, 'basis', 'per_unit', 'source', 'user',
           'source_version', 'per_unit', 'revision_id', null)), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_per_unit) = 'object' then p_per_unit
                         else '{}'::jsonb end) kv
    join catalog_nutrients c on c.code = kv.key
   where p_qty is not null and p_qty > 0
     and case when jsonb_typeof(kv.value) = 'number' then (kv.value)::numeric >= 0 else false end;
$$;
grant execute on function public.compute_unit_snapshot(jsonb, numeric) to authenticated;
grant execute on function public.compute_unit_snapshot(jsonb, numeric) to service_role;

-- A stored per-unit snapshot at a new qty (an edit that resends the item without its per_unit map —
-- a note save, a move, a count change): every amount recomputed from the entry's exact `per_unit`
-- and rounded once. An entry with no exact per-unit number is dropped (unknown), never rescaled
-- from a rounded amount.
create or replace function public.recompute_unit_snapshot(p_snapshot jsonb, p_qty numeric)
returns jsonb language sql immutable security invoker set search_path = public as $$
  select coalesce(jsonb_object_agg(kv.key, kv.value || jsonb_build_object('amount',
           round((kv.value->>'per_unit')::numeric * p_qty, 4))), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_snapshot) = 'object' then p_snapshot
                         else '{}'::jsonb end) kv
   where p_qty is not null and p_qty > 0
     and case when jsonb_typeof(kv.value) = 'object'
                   and kv.value->>'basis' = 'per_unit'
                   and jsonb_typeof(kv.value->'per_unit') = 'number'
              then (kv.value->>'per_unit')::numeric >= 0 else false end;
$$;
grant execute on function public.recompute_unit_snapshot(jsonb, numeric) to authenticated;
grant execute on function public.recompute_unit_snapshot(jsonb, numeric) to service_role;

-- The log_entries branch of _sync_upsert: read `per_unit`, and snapshot an unknown-mass item from
-- it, or from the exact per-unit numbers its stored snapshot already carries. The rest of the
-- installed function is kept as it is.
do $migration$
declare
  definition text;
  pairs text[][] := array[
    ['             case when not v_force
                   and i.id is not null
                   and v_prior ? i.id::text
                   and (v_prior->(i.id::text)->>''grams'')::numeric = i.grams',
     '             case when i.grams is null then
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
                   and (v_prior->(i.id::text)->>''grams'')::numeric = i.grams'],
    ['             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric);',
     '             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric, per_unit jsonb);']];
  i integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('compute_unit_snapshot' in definition) > 0 then return; end if;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(definition) - length(replace(definition, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'log_items_unknown_mass (_sync_upsert): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;
