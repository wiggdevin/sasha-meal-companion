-- Down for 20261231130000_w006_account_day_approval_marks. Run it only after the W006 code is gone.
-- No data moves: approved revisions keep their dates, and day_marks_started_on keeps its value.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $migration$
declare
  definition text;
  froms text[] := array[
    '  v_rest_carbs integer;
  v_day date;',
    '  v_proposed := v_prop.proposed;
  -- W006 (A075, A098): the account''s day, for the revision in force and the new one''s date.
  v_day := public._account_local_date(p_user_id);',
    'effective_from <= v_day',
    '''effective_from'', v_day,'];
  tos text[] := array[
    '  v_rest_carbs integer;',
    '  v_proposed := v_prop.proposed;',
    'effective_from <= current_date',
    '''effective_from'', coalesce(v_prop.week_start, current_date),'];
  i integer;
begin
  select pg_get_functiondef('public.approve_target_proposal(uuid,uuid)'::regprocedure)
    into definition;
  if position('_account_local_date' in definition) = 0 then
    return;
  end if;
  for i in 1 .. array_length(froms, 1) loop
    if (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]) <> 1 then
      raise exception 'w006 down (approve_target_proposal): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, froms[i], tos[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public.approve_target_proposal(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_target_proposal(uuid, uuid) to service_role;

-- 20261209090100's body: the earliest marked local date, moving earlier.
create or replace function public.plan_days_record_first_mark() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.day_complete_at is not null then
    update public.user_settings set day_marks_started_on = new.local_date
      where user_id = new.user_id
        and (day_marks_started_on is null or day_marks_started_on > new.local_date);
  end if;
  return null;
end $$;
revoke all on function public.plan_days_record_first_mark() from public, anon, authenticated;

drop function if exists public._account_local_date(uuid);
