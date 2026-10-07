-- Reverse of 20261209090000_target_seed_freeze.sql: the two functions first, then the columns.
-- Frozen seeds are dropped with the columns; the build this rolls back to re-derives the seed
-- from the live profile and never reads them.
do $refuse$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and exists (select 1 from target_profiles where initial_tdee_kcal is not null) then
    raise exception 'target_seed_freeze down: target_profiles holds frozen seeds; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end;
$refuse$;

do $migration$
declare
  definition text;
  added text[] := array[
    '    initial_tdee_kcal, bmr_kcal, bmr_method, activity_model_version, derivation_version,
',
    '    (p_row->>''initial_tdee_kcal'')::integer, (p_row->>''bmr_kcal'')::integer,
    p_row->>''bmr_method'', p_row->>''activity_model_version'', p_row->>''derivation_version'',
'];
  i integer;
begin
  select pg_get_functiondef('public.write_target_revision(uuid,jsonb)'::regprocedure)
    into definition;
  if position('initial_tdee_kcal' in definition) = 0 then return; end if;
  for i in 1 .. array_length(added, 1) loop
    definition := replace(definition, added[i], '');
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function write_target_revision(uuid, jsonb) from public, anon;
grant execute on function write_target_revision(uuid, jsonb) to authenticated, service_role;

do $migration$
declare
  definition text;
  added text := '
    ''initial_tdee_kcal'', v_active.initial_tdee_kcal,
    ''bmr_kcal'', v_active.bmr_kcal,
    ''bmr_method'', v_active.bmr_method,
    ''activity_model_version'', v_active.activity_model_version,
    ''derivation_version'', v_active.derivation_version,';
begin
  select pg_get_functiondef('public.approve_target_proposal(uuid,uuid)'::regprocedure)
    into definition;
  if position(added in definition) = 0 then return; end if;
  execute replace(definition, added, '');
end;
$migration$;
revoke execute on function approve_target_proposal(uuid, uuid) from public, anon;
grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role;

alter table public.target_profiles
  drop column derivation_version,
  drop column activity_model_version,
  drop column bmr_method,
  drop column bmr_kcal,
  drop column initial_tdee_kcal;
