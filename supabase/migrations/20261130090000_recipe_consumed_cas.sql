-- Recipe consumption is an online, selection-bound transaction. Generic offline
-- plan_days operations remain unchanged; only an accepted recipe uses this RPC.
create table public.recipe_consumed_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  local_date date not null,
  slot_id text not null check (slot_id ~ '^meal-[1-6]$'),
  selection_id uuid not null,
  plan_revision integer not null check (plan_revision > 0),
  actual_servings numeric not null check (actual_servings > 0 and actual_servings <= 20),
  snapshot jsonb not null check (public.recipe_consumed_snapshot_valid(snapshot)),
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
alter table public.recipe_consumed_requests enable row level security;
revoke all on table public.recipe_consumed_requests from public, anon, authenticated;

create function public.recipe_log_consumed(
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
revoke all on function public.recipe_log_consumed(uuid,date,text,uuid,integer,numeric)
  from public, anon, service_role;
grant execute on function public.recipe_log_consumed(uuid,date,text,uuid,integer,numeric)
  to authenticated;
