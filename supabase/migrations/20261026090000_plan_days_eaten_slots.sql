-- Account-owned eaten state for each scheduled slot. Null eaten_at values are durable untick
-- tombstones; changed_at is the per-slot conflict clock used by clients.
alter table public.plan_days
  add column if not exists eaten_slots jsonb not null default '{}'::jsonb;

create or replace function public.plan_day_eaten_slots_valid(value jsonb) returns boolean
  language sql immutable set search_path = public as $$
    select jsonb_typeof(value) = 'object'
      and not exists (
        select 1 from jsonb_each(value) as slot(id, mark)
        where id not in (
          'coffee', 'pouches-pre', 'post-refuel', 'meal-1', 'meal-2', 'meal-3', 'hot-chocolate'
        )
          or jsonb_typeof(mark) <> 'object'
          or not mark ? 'eaten_at'
          or not mark ? 'changed_at'
          or exists (select 1 from jsonb_object_keys(mark) key
                     where key not in ('eaten_at', 'changed_at'))
          or jsonb_typeof(mark->'changed_at') <> 'string'
          or jsonb_typeof(mark->'eaten_at') not in ('string', 'null')
          or not ((mark->>'changed_at') ~
            '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')
          or (mark->>'eaten_at' is not null and not ((mark->>'eaten_at') ~
            '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'))
      );
  $$;

alter table public.plan_days drop constraint if exists plan_days_eaten_slots_shape;
alter table public.plan_days add constraint plan_days_eaten_slots_shape
  check (public.plan_day_eaten_slots_valid(eaten_slots));

-- A synchronized user food must carry the registry ref needed to join its account preference.
create or replace function public._sync_current(
  p_user_id uuid, p_entity text, p_key text
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    select to_jsonb(t) || jsonb_build_object(
      'food_ref_id', (select fr.id from food_refs fr where fr.user_food_id = t.id)
    ) into v from user_foods t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'user_food_prefs' then
    select to_jsonb(t) into v from user_food_prefs t
      where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
  elsif p_entity = 'log_entries' then
    select to_jsonb(e) || jsonb_build_object('items', coalesce(
      (select jsonb_agg(to_jsonb(i) order by i.seq) from log_items i where i.entry_id = e.id),
      '[]'::jsonb)) into v from log_entries e
      where e.user_id = p_user_id and e.id = p_key::uuid;
  elsif p_entity = 'water_log' then
    select to_jsonb(t) into v from water_log t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'plan_days' then
    select to_jsonb(t) into v from plan_days t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'user_settings' then
    select to_jsonb(t) into v from user_settings t where t.user_id = p_user_id;
  elsif p_entity = 'gut_log' then
    select to_jsonb(t) into v from gut_log t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'duplicate_groups' then
    select to_jsonb(t) || jsonb_build_object('fingerprint', encode(t.fingerprint, 'hex'))
      into v from duplicate_groups t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'recipes' then
    select to_jsonb(r) || jsonb_build_object(
      'food_ref_id', (select fr.id from food_refs fr where fr.user_food_id = r.id),
      'revision_id', lr.id, 'revision_rev', lr.rev,
      'nutrients_per_serving', lr.nutrients_per_serving,
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.seq)
        from recipe_items i where i.recipe_revision_id = lr.id), '[]'::jsonb))
      into v from recipes r
      left join lateral (select rv.* from recipe_revisions rv where rv.recipe_id = r.id
        order by rv.rev desc limit 1) lr on true
      where r.user_id = p_user_id and r.id = p_key::uuid;
  elsif p_entity = 'favorites_foods' then
    select to_jsonb(t) into v from favorites_foods t
      where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
  elsif p_entity = 'favorites_recipes' then
    select to_jsonb(t) into v from favorites_recipes t
      where t.user_id = p_user_id and t.recipe_id = p_key::uuid;
  elsif p_entity = 'favorites_meals' then
    select to_jsonb(m) || jsonb_build_object('items', coalesce(
      (select jsonb_agg(to_jsonb(i) order by i.seq) from favorites_meal_items i
        where i.meal_id = m.id), '[]'::jsonb))
      into v from favorites_meals m where m.user_id = p_user_id and m.id = p_key::uuid;
  end if;
  return v;
end; $$;
revoke execute on function public._sync_current(uuid, text, text) from public, anon;

-- Replace only the plan branch of the immediately preceding complete RPC definition. Keeping the
-- rest byte-for-byte avoids duplicating a large cross-entity function in every additive migration.
do $migration$
declare
  definition text;
  replaced text;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position('plan_days_eaten_slots_invalid' in definition) > 0 then
    return;
  end if;
  replaced := regexp_replace(
    definition,
    $pattern$  elsif p_entity = 'plan_days' then.*?  elsif p_entity = 'user_settings' then$pattern$,
    $branch$  elsif p_entity = 'plan_days' then
    if p_payload ? 'eaten_slots'
       and p_payload->'eaten_slots' <> 'null'::jsonb
       and not public.plan_day_eaten_slots_valid(p_payload->'eaten_slots') then
      raise exception 'plan_days_eaten_slots_invalid' using errcode = '22023';
    end if;
    insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                           item_overrides, eaten_slots, rev, updated_at)
    values (p_user_id, p_key::date, p_payload->>'day_type_override',
            coalesce((p_payload->>'floor_day')::boolean, false),
            case when p_payload->'swaps' = 'null'::jsonb then '{}'::jsonb
                 else coalesce(p_payload->'swaps', '{}'::jsonb) end,
            case when p_payload->'slot_notes' = 'null'::jsonb then '{}'::jsonb
                 else coalesce(p_payload->'slot_notes', '{}'::jsonb) end,
            case when p_payload->'item_overrides' = 'null'::jsonb then '{}'::jsonb
                 else coalesce(p_payload->'item_overrides', '{}'::jsonb) end,
            case when p_payload->'eaten_slots' = 'null'::jsonb then '{}'::jsonb
                 else coalesce(p_payload->'eaten_slots', '{}'::jsonb) end,
            p_rev, now())
    on conflict (user_id, local_date) do update set
      day_type_override = case when p_payload ? 'day_type_override'
        then p_payload->>'day_type_override' else plan_days.day_type_override end,
      floor_day = case when p_payload ? 'floor_day'
        then coalesce((p_payload->>'floor_day')::boolean, false) else plan_days.floor_day end,
      swaps = case when p_payload ? 'swaps'
        then case when p_payload->'swaps' = 'null'::jsonb then '{}'::jsonb
          else p_payload->'swaps' end else plan_days.swaps end,
      slot_notes = case when p_payload ? 'slot_notes'
        then case when p_payload->'slot_notes' = 'null'::jsonb then '{}'::jsonb
          else p_payload->'slot_notes' end else plan_days.slot_notes end,
      item_overrides = case when p_payload ? 'item_overrides'
        then case when p_payload->'item_overrides' = 'null'::jsonb then '{}'::jsonb
          else p_payload->'item_overrides' end else plan_days.item_overrides end,
      eaten_slots = case when p_payload ? 'eaten_slots'
        then case when p_payload->'eaten_slots' = 'null'::jsonb then '{}'::jsonb
          else p_payload->'eaten_slots' end else plan_days.eaten_slots end,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'user_settings' then$branch$,
    'is'
  );
  if replaced = definition then
    raise exception 'Could not replace _sync_upsert plan_days branch';
  end if;
  execute replaced;
end;
$migration$;

revoke execute on function public.plan_day_eaten_slots_valid(jsonb) from public, anon;
