-- A recipe log/undo is an online transaction. This private slot row is the
-- authority for its consumed history across generic offline plan-day replays.
create table public.recipe_consumed_slot_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  slot_id text not null check (slot_id ~ '^meal-[1-6]$'),
  mark jsonb not null check (public.plan_day_eaten_slots_valid(
    pg_catalog.jsonb_build_object(slot_id, mark))),
  history_epoch uuid not null,
  primary key (user_id, local_date, slot_id),
  check (mark ? 'history_epoch' and mark->>'history_epoch' = history_epoch::text)
);
alter table public.recipe_consumed_slot_state enable row level security;
revoke all on table public.recipe_consumed_slot_state from public, anon, authenticated;

create table public.recipe_consumed_undo_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  local_date date not null,
  slot_id text not null check (slot_id ~ '^meal-[1-6]$'),
  expected_changed_at timestamptz not null,
  mark jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id),
  check (public.plan_day_eaten_slots_valid(pg_catalog.jsonb_build_object(slot_id, mark)))
);
alter table public.recipe_consumed_undo_requests enable row level security;
revoke all on table public.recipe_consumed_undo_requests from public, anon, authenticated;

-- Old receipts have no proven event identity and therefore fail closed on
-- replay. Every new log stores the epoch minted for that exact eaten mark.
alter table public.recipe_consumed_requests add column history_epoch uuid;

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
      if key not in ('eaten_at', 'changed_at', 'consumed', 'history_epoch') then return false; end if;
    end loop;
    if (slot.value->>'changed_at') !~ iso_pattern or
      (slot.value->>'eaten_at' is not null and
        (slot.value->>'eaten_at') !~ iso_pattern) then return false; end if;
    if slot.value ? 'history_epoch' and
      (jsonb_typeof(slot.value->'history_epoch') is distinct from 'string' or
        (slot.value->>'history_epoch') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      return false;
    end if;
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

-- Preserve C3/C4 history already written before this migration. The backfill is
-- feed-visible so a device with a cursor beyond those original rows sees the epoch.
do $$
declare
  v_day public.plan_days%rowtype;
  v_slot record;
  v_mark jsonb;
  v_marks jsonb;
  v_epoch uuid;
begin
  for v_day in select * from public.plan_days d
    where exists (select 1 from pg_catalog.jsonb_each(d.eaten_slots) s(id, mark)
      where s.mark ? 'consumed') for update loop
    v_marks := v_day.eaten_slots;
    for v_slot in select * from pg_catalog.jsonb_each(v_day.eaten_slots) loop
      if v_slot.value ? 'consumed' then
        v_epoch := gen_random_uuid();
        v_mark := v_slot.value || pg_catalog.jsonb_build_object('history_epoch', v_epoch);
        insert into public.recipe_consumed_slot_state(user_id,local_date,slot_id,mark,history_epoch)
          values(v_day.user_id,v_day.local_date,v_slot.key,v_mark,v_epoch);
        v_marks := v_marks || pg_catalog.jsonb_build_object(v_slot.key, v_mark);
      end if;
    end loop;
    update public.plan_days set eaten_slots=v_marks, rev=rev+1, updated_at=now()
      where user_id=v_day.user_id and local_date=v_day.local_date returning * into v_day;
    insert into public.change_log(user_id,seq,entity,entity_key,rev,op,current)
      values(v_day.user_id,public.next_change_seq(v_day.user_id),'plan_days',
        v_day.local_date::text,v_day.rev,'update',pg_catalog.to_jsonb(v_day));
  end loop;
end $$;

-- A generic sync write may change ordinary marks but cannot create, erase, or
-- resurrect a consumed snapshot. After undo, only the returned epoch can
-- advance the slot into an ordinary mark. Old offline payloads retain the old
-- epoch (or none), so their timestamps cannot override the history boundary.
create function public.recipe_consumed_guard_plan_day() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_state public.recipe_consumed_slot_state%rowtype;
  v_in jsonb;
begin
  for v_state in select * from public.recipe_consumed_slot_state
    where user_id=new.user_id and local_date=new.local_date for update loop
    v_in := new.eaten_slots->v_state.slot_id;
    if v_state.mark ? 'consumed' or v_in is null
      or v_in ? 'consumed'
      or v_in->>'history_epoch' is distinct from v_state.history_epoch::text
      or (v_in->>'changed_at')::timestamptz <
        (v_state.mark->>'changed_at')::timestamptz then
      new.eaten_slots := new.eaten_slots ||
        pg_catalog.jsonb_build_object(v_state.slot_id, v_state.mark);
    elsif v_in is distinct from v_state.mark then
      update public.recipe_consumed_slot_state set mark=v_in
        where user_id=new.user_id and local_date=new.local_date and slot_id=v_state.slot_id;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.jsonb_each(new.eaten_slots) slot(id, mark)
    where (slot.mark ? 'consumed' or slot.mark ? 'history_epoch') and not exists (
      select 1 from public.recipe_consumed_slot_state s
      where s.user_id=new.user_id and s.local_date=new.local_date and s.slot_id=slot.id
        and s.mark=slot.mark)) then
    raise exception 'recipe history marker requires online logging' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.recipe_consumed_guard_plan_day() from public, anon, authenticated;
create trigger recipe_consumed_guard before insert or update on public.plan_days
  for each row execute function public.recipe_consumed_guard_plan_day();

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
  v_epoch uuid;
  v_mark jsonb;
  v_created boolean := false;
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
    if not found or v_request.history_epoch is null
      or v_day.eaten_slots->p_slot_id->'consumed' is distinct from v_request.snapshot
      or v_day.eaten_slots->p_slot_id->>'history_epoch'
        is distinct from v_request.history_epoch::text
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
    v_created := true;
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
  v_epoch := gen_random_uuid();
  v_mark := pg_catalog.jsonb_build_object('eaten_at', v_changed_at,
    'changed_at', v_changed_at, 'consumed', v_snapshot, 'history_epoch', v_epoch);
  insert into public.recipe_consumed_slot_state(user_id,local_date,slot_id,mark,history_epoch)
    values(v_user,p_local_date,p_slot_id,v_mark,v_epoch)
    on conflict (user_id,local_date,slot_id) do update
      set mark=excluded.mark, history_epoch=excluded.history_epoch;
  update public.plan_days set eaten_slots = v_day.eaten_slots ||
      pg_catalog.jsonb_build_object(p_slot_id, v_mark),
    rev = v_day.rev + 1, updated_at = now()
    where user_id=v_user and local_date=p_local_date returning * into v_day;
  insert into public.recipe_consumed_requests(user_id,request_id,local_date,slot_id,
    selection_id,plan_revision,actual_servings,snapshot,history_epoch)
    values(v_user,p_request_id,p_local_date,p_slot_id,p_selection_id,
      p_plan_revision,p_actual_servings,v_snapshot,v_epoch);
  insert into public.change_log(user_id,seq,entity,entity_key,rev,op,op_id,current)
    values(v_user,public.next_change_seq(v_user),'plan_days',p_local_date::text,
      v_day.rev,case when v_created then 'create' else 'update' end,
      p_request_id,pg_catalog.to_jsonb(v_day));
  return pg_catalog.jsonb_build_object('row', pg_catalog.to_jsonb(v_day), 'replayed', false);
end $$;

create function public.recipe_undo_consumed(
  p_request_id uuid, p_local_date date, p_slot_id text, p_expected_changed_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_day public.plan_days%rowtype;
  v_state public.recipe_consumed_slot_state%rowtype;
  v_receipt public.recipe_consumed_undo_requests%rowtype;
  v_epoch uuid;
  v_mark jsonb;
  v_changed_at timestamptz;
begin
  if v_user is null then raise exception 'unauthorized' using errcode='42501'; end if;
  if p_request_id is null or p_local_date is null or p_slot_id is null
    or p_slot_id !~ '^meal-[1-6]$' or p_expected_changed_at is null then
    raise exception 'invalid recipe undo' using errcode='22023';
  end if;
  -- Accept and log lock the account state before the day. Keep the same
  -- ordering so undo cannot deadlock with an accept on this date.
  perform 1 from public.recipe_plan_state where user_id=v_user for update;
  select * into v_day from public.plan_days
    where user_id=v_user and local_date=p_local_date for update nowait;
  if not found then raise exception 'logged meal changed' using errcode='40001'; end if;
  select * into v_state from public.recipe_consumed_slot_state
    where user_id=v_user and local_date=p_local_date and slot_id=p_slot_id for update;
  if not found then raise exception 'logged meal changed' using errcode='40001'; end if;
  select * into v_receipt from public.recipe_consumed_undo_requests
    where user_id=v_user and request_id=p_request_id;
  if found then
    if v_receipt.local_date is distinct from p_local_date
      or v_receipt.slot_id is distinct from p_slot_id
      or v_receipt.expected_changed_at is distinct from p_expected_changed_at then
      raise exception 'request key was used for a different undo' using errcode='22023';
    end if;
    if v_day.eaten_slots->p_slot_id is distinct from v_receipt.mark
      or v_state.mark is distinct from v_receipt.mark then
      raise exception 'logged meal changed after this request' using errcode='40001';
    end if;
    return pg_catalog.jsonb_build_object('row',pg_catalog.to_jsonb(v_day),'replayed',true);
  end if;
  if not (v_state.mark ? 'consumed')
    or v_day.eaten_slots->p_slot_id is distinct from v_state.mark
    or (v_state.mark->>'changed_at')::timestamptz is distinct from p_expected_changed_at then
    raise exception 'logged meal changed' using errcode='40001';
  end if;
  v_changed_at := pg_catalog.clock_timestamp();
  v_epoch := gen_random_uuid();
  v_mark := pg_catalog.jsonb_build_object('eaten_at',null,'changed_at',v_changed_at,
    'history_epoch',v_epoch);
  update public.recipe_consumed_slot_state set mark=v_mark, history_epoch=v_epoch
    where user_id=v_user and local_date=p_local_date and slot_id=p_slot_id;
  update public.plan_days set eaten_slots=v_day.eaten_slots ||
      pg_catalog.jsonb_build_object(p_slot_id,v_mark),
    rev=v_day.rev+1, updated_at=now()
    where user_id=v_user and local_date=p_local_date returning * into v_day;
  insert into public.recipe_consumed_undo_requests
    (user_id,request_id,local_date,slot_id,expected_changed_at,mark)
    values(v_user,p_request_id,p_local_date,p_slot_id,p_expected_changed_at,v_mark);
  insert into public.change_log(user_id,seq,entity,entity_key,rev,op,op_id,current)
    values(v_user,public.next_change_seq(v_user),'plan_days',p_local_date::text,
      v_day.rev,'update',p_request_id,pg_catalog.to_jsonb(v_day));
  return pg_catalog.jsonb_build_object('row',pg_catalog.to_jsonb(v_day),'replayed',false);
end $$;
revoke all on function public.recipe_undo_consumed(uuid,date,text,timestamptz)
  from public, anon, service_role;
grant execute on function public.recipe_undo_consumed(uuid,date,text,timestamptz)
  to authenticated;
