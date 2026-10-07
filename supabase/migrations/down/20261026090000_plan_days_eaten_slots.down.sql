-- Restore the immediately preceding plan_days branch before removing eaten_slots.
do $migration$
declare
  definition text;
  replaced text;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position('plan_days_eaten_slots_invalid' in definition) = 0 then
    return;
  end if;
  replaced := regexp_replace(
    definition,
    $pattern$  elsif p_entity = 'plan_days' then.*?  elsif p_entity = 'user_settings' then$pattern$,
    $branch$  elsif p_entity = 'plan_days' then
    insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                           item_overrides, rev, updated_at)
    values (p_user_id, p_key::date, p_payload->>'day_type_override',
            coalesce((p_payload->>'floor_day')::boolean, false),
            coalesce(p_payload->'swaps', '{}'::jsonb),
            coalesce(p_payload->'slot_notes', '{}'::jsonb),
            coalesce(p_payload->'item_overrides', '{}'::jsonb), p_rev, now())
    on conflict (user_id, local_date) do update set day_type_override = excluded.day_type_override,
      floor_day = excluded.floor_day, swaps = excluded.swaps, slot_notes = excluded.slot_notes,
      item_overrides = excluded.item_overrides,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'user_settings' then$branch$,
    'is'
  );
  if replaced = definition then
    raise exception 'Could not restore _sync_upsert plan_days branch';
  end if;
  execute replaced;
end;
$migration$;

alter table public.plan_days drop constraint if exists plan_days_eaten_slots_shape;
alter table public.plan_days drop column if exists eaten_slots;
drop function if exists public.plan_day_eaten_slots_valid(jsonb);

-- Restore the prior user_foods current-row shape without the additive registry ref.
create or replace function public._sync_current(
  p_user_id uuid, p_entity text, p_key text
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    select to_jsonb(t) into v from user_foods t where t.user_id = p_user_id and t.id = p_key::uuid;
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
