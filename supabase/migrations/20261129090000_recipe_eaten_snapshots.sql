-- A recipe's actual consumed portion belongs to its eaten mark, not item_overrides.
-- Legacy timestamp-only marks stay valid. No table, policy, or sync RPC grant changes.
create function public.recipe_consumed_snapshot_valid(value jsonb) returns boolean
  language plpgsql immutable set search_path = '' as $$
declare
  component jsonb;
  macros jsonb;
  nutrient text;
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(value)) <> 3 or
     not (value ? 'baseMealId' and value ? 'title' and value ? 'components') or
     jsonb_typeof(value->'baseMealId') is distinct from 'string' or
     jsonb_typeof(value->'title') is distinct from 'string' or
     (value->>'baseMealId') not like 'recipe:%' or
     length(value->>'baseMealId') not between 8 and 160 or
     length(value->>'title') not between 1 and 80 or
     jsonb_typeof(value->'components') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(value->'components') <> 1 then return false; end if;
  component := value->'components'->0;
  if jsonb_typeof(component) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(component)) <> 5 or
     not (component ? 'name' and component ? 'qty' and component ? 'unit'
       and component ? 'role' and component ? 'macros') or
     jsonb_typeof(component->'name') is distinct from 'string' or
     length(component->>'name') not between 1 and 80 or
     jsonb_typeof(component->'qty') is distinct from 'number' or
     component->>'unit' is distinct from 'whole' or
     component->>'role' is distinct from 'free' then
    return false;
  end if;
  if (component->>'qty')::numeric <= 0 or (component->>'qty')::numeric > 20 then
    return false;
  end if;
  macros := component->'macros';
  if jsonb_typeof(macros) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(macros)) <> 4 then return false; end if;
  foreach nutrient in array array['kcal', 'protein', 'carbs', 'fat'] loop
    if not (macros ? nutrient) or
       jsonb_typeof(macros->nutrient) is distinct from 'number' then return false; end if;
    if (macros->>nutrient)::numeric < 0 or (macros->>nutrient)::numeric > 1000000 then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.plan_day_eaten_slots_valid(value jsonb) returns boolean
  language plpgsql immutable set search_path = '' as $$
declare
  slot record;
  key text;
  iso_pattern constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$';
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  for slot in select * from jsonb_each(value) loop
    if slot.key not in ('coffee', 'pouches-pre', 'post-refuel', 'meal-1',
      'meal-2', 'meal-3', 'meal-4', 'meal-5', 'meal-6', 'hot-chocolate') or
      jsonb_typeof(slot.value) is distinct from 'object' or
      not (slot.value ? 'eaten_at' and slot.value ? 'changed_at') or
      jsonb_typeof(slot.value->'changed_at') is distinct from 'string' or
      jsonb_typeof(slot.value->'eaten_at') not in ('string', 'null') then
      return false;
    end if;
    for key in select jsonb_object_keys(slot.value) loop
      if key not in ('eaten_at', 'changed_at', 'consumed') then return false; end if;
    end loop;
    if (slot.value->>'changed_at') !~ iso_pattern or
      (slot.value->>'eaten_at' is not null and
        (slot.value->>'eaten_at') !~ iso_pattern) then return false; end if;
    if slot.value ? 'consumed' and
      (slot.value->>'eaten_at' is null or
        not public.recipe_consumed_snapshot_valid(slot.value->'consumed')) then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

-- The plan_days constraint runs as the writing role on direct authenticated and
-- service-role writes; its validator therefore needs this helper privilege.
revoke execute on function public.recipe_consumed_snapshot_valid(jsonb) from public, anon;
grant execute on function public.recipe_consumed_snapshot_valid(jsonb) to authenticated, service_role;

-- Keep B's captured-slot replay rule. A new explicit swap-clear leaves no
-- swaps key and a followPlan override, so its slot marker must still retire
-- the accepted selection. Delayed old replays retain the captured marker.
create or replace function public.recipe_plan_supersede_on_day() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.recipe_plan_selections s set superseded_at=now(), updated_at=now()
    where s.user_id=new.user_id and s.local_date=new.local_date
      and s.superseded_at is null
      and (
        ((new.item_overrides->s.slot_id->>'mutationId') is not null
          and (new.item_overrides->s.slot_id->>'mutationId')
            is distinct from (s.baseline_override->>'mutationId'))
        or ((new.swaps ? s.slot_id or (new.item_overrides ? s.slot_id and
          coalesce((new.item_overrides->s.slot_id->>'followPlan')::boolean,false)=false))
          and ((new.swaps->s.slot_id) is distinct from s.baseline_swap
            or ((new.item_overrides->s.slot_id) - 'time' - 'mutationId')
              is distinct from (s.baseline_override - 'time' - 'mutationId')))
      );
  return new;
end $$;
revoke all on function public.recipe_plan_supersede_on_day() from public, anon, authenticated;
