-- TDEE step E1 (docs/specs/phase-16-adaptive-handoff.md): every target revision freezes the
-- formula seed it was derived from, so the expenditure engine reads the start a revision was
-- built on instead of re-deriving it from whatever the live profile says tonight.
-- All five columns are nullable: rows written before this migration keep null, and the engine
-- falls back to the live profile seed for them.
alter table public.target_profiles
  add column initial_tdee_kcal integer
    constraint target_profiles_initial_tdee_kcal_range check (initial_tdee_kcal between 500 and 10000),
  add column bmr_kcal integer
    constraint target_profiles_bmr_kcal_range check (bmr_kcal between 300 and 6000),
  add column bmr_method text
    constraint target_profiles_bmr_method_check check (bmr_method in ('mifflin', 'katch')),
  add column activity_model_version text,
  add column derivation_version text;

-- 1. `write_target_revision` stores the five keys when a writer sends them. The new columns go
--    BEFORE the existing tail, so the text earlier migrations test for as their "already
--    applied" marker (`formula_name, kcal_min_source)`) stays exactly as it was.
do $migration$
declare
  definition text;
  anchors text[] := array[
    '    input_activity_level, input_goal, formula_name, kcal_min_source)',
    '    p_row->>''input_activity_level'', p_row->>''input_goal'', p_row->>''formula_name'','];
  replacements text[] := array[
    '    initial_tdee_kcal, bmr_kcal, bmr_method, activity_model_version, derivation_version,
    input_activity_level, input_goal, formula_name, kcal_min_source)',
    '    (p_row->>''initial_tdee_kcal'')::integer, (p_row->>''bmr_kcal'')::integer,
    p_row->>''bmr_method'', p_row->>''activity_model_version'', p_row->>''derivation_version'',
    p_row->>''input_activity_level'', p_row->>''input_goal'', p_row->>''formula_name'','];
  i integer;
begin
  select pg_get_functiondef('public.write_target_revision(uuid,jsonb)'::regprocedure)
    into definition;
  if position('initial_tdee_kcal' in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'target_seed_freeze (write_target_revision): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function write_target_revision(uuid, jsonb) from public, anon;
grant execute on function write_target_revision(uuid, jsonb) to authenticated, service_role;

-- 2. `approve_target_proposal`: an approved proposal changes the numbers, not the formula start,
--    so it carries the active revision's seed forward. Inserted after the rate-goals line, which
--    stays intact for the same marker reason as above.
do $migration$
declare
  definition text;
  anchors text[] := array[
    '''kcal_min_source'', coalesce(v_active.kcal_min_source, ''legacy_default''),'];
  replacements text[] := array[
    '''kcal_min_source'', coalesce(v_active.kcal_min_source, ''legacy_default''),
    ''initial_tdee_kcal'', v_active.initial_tdee_kcal,
    ''bmr_kcal'', v_active.bmr_kcal,
    ''bmr_method'', v_active.bmr_method,
    ''activity_model_version'', v_active.activity_model_version,
    ''derivation_version'', v_active.derivation_version,'];
  i integer;
begin
  select pg_get_functiondef('public.approve_target_proposal(uuid,uuid)'::regprocedure)
    into definition;
  if position('initial_tdee_kcal' in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'target_seed_freeze (approve_target_proposal): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function approve_target_proposal(uuid, uuid) from public, anon;
grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role;
