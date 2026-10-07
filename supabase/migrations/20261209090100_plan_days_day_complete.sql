-- TDEE step E6 (docs/specs/phase-16-adaptive-handoff.md): the user's own "day fully logged"
-- mark. Calorie coverage proves the logged foods have calorie data, not that everything eaten was
-- logged; only this mark says that. Null means not marked. The server never sets it.
alter table public.plan_days add column day_complete_at timestamptz;

-- `_sync_upsert` plan_days branch: the omit/keep, present-null/clear rule every plan_days field
-- follows. Three anchors, each exactly once; a re-run is a no-op.
do $migration$
declare
  definition text;
  anchors text[] := array[
    'item_overrides, eaten_slots, rev, updated_at)',
    'else coalesce(p_payload->''eaten_slots'', ''{}''::jsonb) end,
            p_rev, now())',
    'else p_payload->''eaten_slots'' end else plan_days.eaten_slots end,'];
  replacements text[] := array[
    'item_overrides, eaten_slots, day_complete_at, rev, updated_at)',
    'else coalesce(p_payload->''eaten_slots'', ''{}''::jsonb) end,
            (p_payload->>''day_complete_at'')::timestamptz,
            p_rev, now())',
    'else p_payload->''eaten_slots'' end else plan_days.eaten_slots end,
      day_complete_at = case when p_payload ? ''day_complete_at''
        then (p_payload->>''day_complete_at'')::timestamptz else plan_days.day_complete_at end,'];
  i integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('day_complete_at' in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'plan_days_day_complete (_sync_upsert): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;

-- Ruling R3 (docs/decisions/2026-10-04-adaptive-handoff-rulings.md): the date marking began. Before
-- it, a coverage-complete day still counts; on and after it, only marked days do. It is set from
-- the earliest marked local date and never moves later, so clearing a mark cannot bring the old
-- rule back. Server-owned: no sync writer sends it.
alter table public.user_settings add column day_marks_started_on date;

create function public.plan_days_record_first_mark() returns trigger
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
create trigger plan_days_record_first_mark after insert or update of day_complete_at
  on public.plan_days for each row execute function public.plan_days_record_first_mark();
