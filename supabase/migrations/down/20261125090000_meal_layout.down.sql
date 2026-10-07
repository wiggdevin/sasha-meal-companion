-- Roll back the meal-count sync field before dropping the column. Retain the widened eaten-slot
-- validator: plan_days can now hold genuine meal-4..6 marks, and narrowing it would strand them.
do $refuse$
begin
  if exists (select 1 from public.user_settings where meals_per_day is not null)
     and coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on' then
    raise exception 'meal_layout down: explicit meal counts exist; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end;
$refuse$;

do $migration$
declare
  definition text;
  anchors text[] := array[
    'body_fat_measured_on, goal_rate_bp_week, meals_per_day, rev)',
    '(p_payload->>''goal_rate_bp_week'')::integer,
            (p_payload->>''meals_per_day'')::smallint, p_rev)',
    'else user_settings.goal_rate_bp_week end,
      meals_per_day = case when p_payload ? ''meals_per_day''
        then (p_payload->>''meals_per_day'')::smallint
        else user_settings.meals_per_day end,'];
  replacements text[] := array[
    'body_fat_measured_on, goal_rate_bp_week, rev)',
    '(p_payload->>''goal_rate_bp_week'')::integer, p_rev)',
    'else user_settings.goal_rate_bp_week end,'];
  i integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'meal_layout down (_sync_upsert): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  to service_role;

alter table public.user_settings drop column if exists meals_per_day;
