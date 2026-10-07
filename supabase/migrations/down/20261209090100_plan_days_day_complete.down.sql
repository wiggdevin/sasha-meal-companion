-- Reverse of 20261209090100_plan_days_day_complete.sql: the sync branch first, then the column.
do $refuse$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and (exists (select 1 from plan_days where day_complete_at is not null)
          or exists (select 1 from user_settings where day_marks_started_on is not null)) then
    raise exception 'plan_days_day_complete down: plan_days holds day marks; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end;
$refuse$;

do $migration$
declare
  definition text;
  pairs text[][] := array[
    ['item_overrides, eaten_slots, day_complete_at, rev, updated_at)',
     'item_overrides, eaten_slots, rev, updated_at)'],
    ['
            (p_payload->>''day_complete_at'')::timestamptz,', ''],
    ['
      day_complete_at = case when p_payload ? ''day_complete_at''
        then (p_payload->>''day_complete_at'')::timestamptz else plan_days.day_complete_at end,', '']];
  i integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('day_complete_at' in definition) = 0 then return; end if;
  for i in 1 .. array_length(pairs, 1) loop
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;

drop trigger if exists plan_days_record_first_mark on public.plan_days;
drop function if exists public.plan_days_record_first_mark();
alter table public.user_settings drop column day_marks_started_on;
alter table public.plan_days drop column day_complete_at;
