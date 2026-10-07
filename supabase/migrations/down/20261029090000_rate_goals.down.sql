-- Reverse of 20261029090000_rate_goals.sql: the three functions first, then the columns. The
-- confirmed rates and the minimum-source labels are dropped with the columns; the build this rolls
-- back to derives from its own goal offsets and never reads them.
-- Refuse to drop data written since the forward migration unless the operator says so for this
-- transaction: `set local app.allow_down_data_loss = 'on';` before running this file.
do $refuse$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and (exists (select 1 from user_settings where goal_rate_bp_week is not null)
          or exists (select 1 from target_profiles where kcal_min_source <> 'legacy_default'
                     or input_weight_source = 'trend')) then
    raise exception 'rate_goals down: user_settings.goal_rate_bp_week / target_profiles.kcal_min_source / trend weights hold data; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end;
$refuse$;

do $migration$
declare
  definition text;
  anchors text[] := array[
    'body_fat_measured_on, goal_rate_bp_week, rev)',
    '(p_payload->>''body_fat_measured_on'')::date,
            (p_payload->>''goal_rate_bp_week'')::integer, p_rev)',
    'else user_settings.body_fat_measured_on end,
      goal_rate_bp_week = case when p_payload ? ''goal_rate_bp_week''
        then (p_payload->>''goal_rate_bp_week'')::integer
        else user_settings.goal_rate_bp_week end,'];
  replacements text[] := array[
    'body_fat_measured_on, rev)',
    '(p_payload->>''body_fat_measured_on'')::date, p_rev)',
    'else user_settings.body_fat_measured_on end,'];
  i integer;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position(anchors[1] in definition) = 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'rate_goals down (_sync_upsert): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon, authenticated;

do $migration$
declare
  definition text;
  anchors text[] := array[
    'input_activity_level, input_goal, formula_name, kcal_min_source)',
    'p_row->>''input_activity_level'', p_row->>''input_goal'', p_row->>''formula_name'',
    coalesce(p_row->>''kcal_min_source'', ''legacy_default''))'];
  replacements text[] := array[
    'input_activity_level, input_goal, formula_name)',
    'p_row->>''input_activity_level'', p_row->>''input_goal'', p_row->>''formula_name'')'];
  i integer;
begin
  select pg_get_functiondef('public.write_target_revision(uuid,jsonb)'::regprocedure)
    into definition;
  if position(anchors[1] in definition) = 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'rate_goals down (write_target_revision): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function write_target_revision(uuid, jsonb) from public, anon;
grant execute on function write_target_revision(uuid, jsonb) to authenticated, service_role;

do $migration$
declare
  definition text;
  anchors text[] := array[
    'then null else ''trend'' end,',
    '''kcal_min'', coalesce(v_active.kcal_min, 1650),
    ''kcal_min_source'', coalesce(v_active.kcal_min_source, ''legacy_default''),'];
  replacements text[] := array[
    'then null else ''weigh-in'' end,',
    '''kcal_min'', coalesce(v_active.kcal_min, 1650),'];
  i integer;
begin
  select pg_get_functiondef('public.approve_target_proposal(uuid,uuid)'::regprocedure)
    into definition;
  if position(anchors[1] in definition) = 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'rate_goals down (approve_target_proposal): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function approve_target_proposal(uuid, uuid) from public, anon;
grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role;

-- The narrow weight-source check again. A trend weight was labelled 'weigh-in' before step D, so
-- an approved row keeps its weight under that older label.
update target_profiles set input_weight_source = 'weigh-in' where input_weight_source = 'trend';
alter table target_profiles
  drop constraint target_profiles_input_weight_source_check,
  add constraint target_profiles_input_weight_source_check
    check (input_weight_source in ('weigh-in', 'onboarding'));

alter table target_profiles drop column kcal_min_source;
alter table user_settings drop column goal_rate_bp_week;
