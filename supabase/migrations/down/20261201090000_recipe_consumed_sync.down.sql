-- Consumed history and its offline replay boundary cannot be discarded by a
-- downgrade. Archive/migrate that history explicitly before rolling back.
do $$ begin
  if exists(select 1 from public.recipe_consumed_slot_state)
    or exists(select 1 from public.recipe_consumed_undo_requests)
    or exists(select 1 from public.recipe_consumed_requests where history_epoch is not null)
    or exists(select 1 from public.plan_days d,
      lateral pg_catalog.jsonb_each(d.eaten_slots) slot(id,mark)
      where slot.mark ? 'history_epoch') then
    raise exception 'recipe consumed slot history exists; downgrade would lose replay protection';
  end if;
end $$;
drop trigger recipe_consumed_guard on public.plan_days;
drop function public.recipe_consumed_guard_plan_day();
drop function public.recipe_undo_consumed(uuid,date,text,timestamptz);
drop table public.recipe_consumed_undo_requests;
drop table public.recipe_consumed_slot_state;
alter table public.recipe_consumed_requests drop column history_epoch;

create or replace function public.recipe_log_consumed(
  p_request_id uuid, p_local_date date, p_slot_id text, p_selection_id uuid,
  p_plan_revision integer, p_actual_servings numeric
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_request public.recipe_consumed_requests%rowtype;
  v_day public.plan_days%rowtype;
  v_selection public.recipe_plan_selections%rowtype;
  v_macros jsonb := '{}'::jsonb;
  v_snapshot jsonb;
  v_code text;
  v_evidence jsonb;
  v_value numeric;
  v_changed_at timestamptz;
begin
  if v_user is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if p_request_id is null or p_local_date is null or p_slot_id is null
    or p_slot_id !~ '^meal-[1-6]$'
    or p_selection_id is null or p_plan_revision is null or p_plan_revision <= 0
    or p_actual_servings is null or not (p_actual_servings > 0 and p_actual_servings <= 20) then
    raise exception 'invalid recipe consumption' using errcode = '22023';
  end if;
  -- Accept takes this lock before it reads a day or selection. Whichever
  -- transaction wins sees the other's committed state before proceeding.
  perform 1 from public.recipe_plan_state where user_id=v_user for update;
  if not found then raise exception 'accepted plan changed' using errcode = '40001'; end if;
  select * into v_request from public.recipe_consumed_requests
    where user_id=v_user and request_id=p_request_id;
  if found then
    if v_request.local_date is distinct from p_local_date
      or v_request.slot_id is distinct from p_slot_id
      or v_request.selection_id is distinct from p_selection_id
      or v_request.plan_revision is distinct from p_plan_revision
      or v_request.actual_servings is distinct from p_actual_servings then
      raise exception 'request key was used for a different consumption' using errcode = '22023';
    end if;
    select * into v_day from public.plan_days
      where user_id=v_user and local_date=p_local_date for update nowait;
    if not found or v_day.eaten_slots->p_slot_id->'consumed' is distinct from v_request.snapshot
      or v_day.eaten_slots->p_slot_id->>'eaten_at' is null then
      raise exception 'logged meal changed after this request' using errcode = '40001';
    end if;
    return pg_catalog.jsonb_build_object('row', pg_catalog.to_jsonb(v_day), 'replayed', true);
  end if;
  select * into v_day from public.plan_days
    where user_id=v_user and local_date=p_local_date for update nowait;
  if not found then
    -- Accepted selections can exist before their first local plan_days row.
    -- A short lock timeout turns a competing insert into a retryable error.
    perform pg_catalog.set_config('lock_timeout', '1000ms', true);
    insert into public.plan_days(user_id, local_date) values (v_user, p_local_date)
      returning * into v_day;
  end if;
  select * into v_selection from public.recipe_plan_selections
    where user_id=v_user and local_date=p_local_date and slot_id=p_slot_id for update nowait;
  if not found or v_selection.superseded_at is not null
    or v_selection.id is distinct from p_selection_id
    or v_selection.plan_revision is distinct from p_plan_revision then
    raise exception 'accepted plan changed' using errcode = '40001';
  end if;
  if v_day.eaten_slots->p_slot_id->>'eaten_at' is not null then
    raise exception 'meal already eaten' using errcode = '40001';
  end if;
  if v_selection.serving_fraction <= 0 then
    raise exception 'invalid accepted serving' using errcode = '22023';
  end if;
  foreach v_code in array array['kcal','protein','carbs','fat'] loop
    v_evidence := v_selection.nutrition_snapshot->v_code;
    if pg_catalog.jsonb_typeof(v_evidence->'value') is distinct from 'number'
      or v_evidence->>'status' not in ('known', 'estimated')
      or v_evidence->>'status' is null then
      raise exception 'accepted nutrition is incomplete' using errcode = '22023';
    end if;
    v_value := (v_evidence->>'value')::numeric * p_actual_servings / v_selection.serving_fraction;
    if v_value < 0 or v_value > 1000000 then
      raise exception 'consumed nutrition is out of bounds' using errcode = '22023';
    end if;
    v_macros := v_macros || pg_catalog.jsonb_build_object(v_code, v_value);
  end loop;
  v_snapshot := pg_catalog.jsonb_build_object(
    'baseMealId', 'recipe:' || v_selection.recipe_revision_id::text,
    'title', v_selection.recipe_name,
    'components', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'name', v_selection.recipe_name, 'qty', p_actual_servings,
      'unit', 'whole', 'role', 'free', 'macros', v_macros)));
  if not public.recipe_consumed_snapshot_valid(v_snapshot) then
    raise exception 'invalid consumed snapshot' using errcode = '22023';
  end if;
  v_changed_at := pg_catalog.clock_timestamp();
  update public.plan_days set eaten_slots = v_day.eaten_slots || pg_catalog.jsonb_build_object(
      p_slot_id, pg_catalog.jsonb_build_object('eaten_at', v_changed_at,
        'changed_at', v_changed_at, 'consumed', v_snapshot)),
    rev = v_day.rev + 1, updated_at = now()
    where user_id=v_user and local_date=p_local_date returning * into v_day;
  insert into public.recipe_consumed_requests(user_id,request_id,local_date,slot_id,
    selection_id,plan_revision,actual_servings,snapshot)
    values(v_user,p_request_id,p_local_date,p_slot_id,p_selection_id,
      p_plan_revision,p_actual_servings,v_snapshot);
  return pg_catalog.jsonb_build_object('row', pg_catalog.to_jsonb(v_day), 'replayed', false);
end $$;

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
