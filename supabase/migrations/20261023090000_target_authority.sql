-- U1: target_profiles is the one target authority. Existing rows stay readable through the
-- legacy columns; every new authority field is nullable so the migration is additive and safe
-- before the application deploys.
alter table target_profiles
  add column target_source text check (target_source in ('derived','proposal','manual')),
  add column training_macros jsonb
    check (training_macros is null or jsonb_typeof(training_macros) = 'object'),
  add column rest_macros jsonb
    check (rest_macros is null or jsonb_typeof(rest_macros) = 'object'),
  add column pin_training_kcal integer,
  add column pin_rest_kcal integer,
  add column pin_protein_g numeric,
  add column input_weight_kg numeric check (input_weight_kg is null or input_weight_kg between 20 and 400),
  add column input_weight_source text
    check (input_weight_source in ('weigh-in','onboarding')),
  add column input_training_weekdays smallint[],
  add column input_activity_level text
    check (input_activity_level in ('sedentary','light','moderate','active','very_active')),
  add column input_goal text
    check (input_goal in ('lose_fat','recomp','maintain','gain_muscle')),
  add column formula_name text;

-- One transaction chooses the next per-user revision, inserts the row and makes it pullable.
create function write_target_revision(p_user_id uuid, p_row jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_profile target_profiles%rowtype;
  v_training jsonb := p_row->'training_macros';
  v_rest jsonb := p_row->'rest_macros';
  v_rev integer;
  v_seq bigint;
begin
  perform _sync_assert_caller(p_user_id);
  if v_training is null or v_rest is null then
    raise exception 'target_macros_required' using errcode = '22023';
  end if;

  -- Serialise same-user writers so two devices cannot mint the same revision.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select coalesce(max(rev), 0) + 1 into v_rev
    from target_profiles where user_id = p_user_id;

  insert into target_profiles (
    user_id, effective_from, rev, kcal_train, kcal_rest, authored_by, mode,
    protein_g, fat_g, carb_g, protein_pct, fat_pct, carb_pct,
    kcal_min, protein_g_min, fat_g_min, carb_g_min,
    goal_rate_bp_week, max_weekly_kcal_step, notes,
    target_source, training_macros, rest_macros,
    pin_training_kcal, pin_rest_kcal, pin_protein_g,
    input_weight_kg, input_weight_source, input_training_weekdays,
    input_activity_level, input_goal, formula_name)
  values (
    p_user_id, (p_row->>'effective_from')::date, v_rev,
    (v_training->>'kcal')::integer, (v_rest->>'kcal')::integer,
    case when p_row->>'target_source' = 'proposal' then 'engine_proposal' else 'user' end,
    coalesce(p_row->>'mode', 'grams'),
    (v_training->>'protein')::numeric, (v_training->>'fat')::numeric,
    (v_training->>'carbs')::numeric,
    (p_row->>'protein_pct')::numeric, (p_row->>'fat_pct')::numeric,
    (p_row->>'carb_pct')::numeric,
    coalesce((p_row->>'kcal_min')::integer, 1650),
    coalesce((p_row->>'protein_g_min')::numeric, (v_training->>'protein')::numeric),
    coalesce((p_row->>'fat_g_min')::numeric, 50),
    coalesce((p_row->>'carb_g_min')::numeric, 100),
    coalesce((p_row->>'goal_rate_bp_week')::integer, 0),
    coalesce((p_row->>'max_weekly_kcal_step')::integer, 150),
    p_row->>'notes',
    p_row->>'target_source', v_training, v_rest,
    (p_row->>'pin_training_kcal')::integer, (p_row->>'pin_rest_kcal')::integer,
    (p_row->>'pin_protein_g')::numeric,
    (p_row->>'input_weight_kg')::numeric, p_row->>'input_weight_source',
    case when p_row->'input_training_weekdays' is null
           or jsonb_typeof(p_row->'input_training_weekdays') = 'null' then null
      else array(select value::smallint
        from jsonb_array_elements_text(p_row->'input_training_weekdays')) end,
    p_row->>'input_activity_level', p_row->>'input_goal', p_row->>'formula_name')
  returning * into v_profile;

  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, 'target_profiles', v_profile.id::text, v_profile.rev, 'create',
          null, to_jsonb(v_profile));
  return to_jsonb(v_profile);
end; $$;
revoke execute on function write_target_revision(uuid, jsonb) from public, anon;
grant execute on function write_target_revision(uuid, jsonb) to authenticated, service_role;

-- Keep proposal approval on the same revision stream and fill every input available to it.
create or replace function approve_target_proposal(p_user_id uuid, p_proposal_id uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prop target_proposals%rowtype;
  v_proposed jsonb;
  v_active target_profiles%rowtype;
  v_profile target_profiles%rowtype;
  v_estimate expenditure_estimates%rowtype;
  v_settings user_settings%rowtype;
  v_rev integer;
  v_seq bigint;
  v_rest_carbs integer;
begin
  perform _sync_assert_caller(p_user_id);
  select * into v_prop from target_proposals
    where id = p_proposal_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_prop.status <> 'pending' then
    return jsonb_build_object('status', 'conflict', 'current', to_jsonb(v_prop));
  end if;
  v_proposed := v_prop.proposed;

  select * into v_active from target_profiles
    where user_id = p_user_id and effective_from <= current_date
    order by effective_from desc, rev desc limit 1;
  select * into v_estimate from expenditure_estimates
    where id = v_prop.based_on_estimate_id and user_id = p_user_id;
  select * into v_settings from user_settings where user_id = p_user_id;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select coalesce(max(rev), 0) + 1 into v_rev
    from target_profiles where user_id = p_user_id;
  v_rest_carbs := round(((v_proposed->>'kcalRest')::numeric
    - 4 * (v_proposed->>'proteinG')::numeric
    - 9 * (v_proposed->>'fatG')::numeric) / 4);

  insert into target_profiles (
    user_id, effective_from, rev, kcal_train, kcal_rest, authored_by,
    mode, protein_g, fat_g, carb_g, kcal_min, protein_g_min, fat_g_min, carb_g_min,
    goal_rate_bp_week, max_weekly_kcal_step, notes,
    target_source, training_macros, rest_macros,
    pin_training_kcal, pin_rest_kcal, pin_protein_g,
    input_weight_kg, input_weight_source, input_training_weekdays,
    input_activity_level, input_goal, formula_name)
  values (
    p_user_id, coalesce(v_prop.week_start, current_date), v_rev,
    (v_proposed->>'kcalTrain')::integer, (v_proposed->>'kcalRest')::integer,
    'engine_proposal', 'grams', (v_proposed->>'proteinG')::numeric,
    (v_proposed->>'fatG')::numeric, (v_proposed->>'carbG')::numeric,
    coalesce(v_active.kcal_min, 1650),
    coalesce(v_active.protein_g_min, (v_proposed->>'proteinG')::numeric),
    coalesce(v_active.fat_g_min, 50), coalesce(v_active.carb_g_min, 0),
    coalesce(v_active.goal_rate_bp_week, 0), coalesce(v_active.max_weekly_kcal_step, 150),
    'Approved from proposal ' || p_proposal_id::text,
    'proposal',
    jsonb_build_object('kcal', (v_proposed->>'kcalTrain')::integer,
      'protein', (v_proposed->>'proteinG')::numeric,
      'carbs', (v_proposed->>'carbG')::numeric, 'fat', (v_proposed->>'fatG')::numeric),
    jsonb_build_object('kcal', (v_proposed->>'kcalRest')::integer,
      'protein', (v_proposed->>'proteinG')::numeric,
      'carbs', v_rest_carbs, 'fat', (v_proposed->>'fatG')::numeric),
    null, null, null,
    v_estimate.weight_trend_kg,
    case when v_estimate.weight_trend_kg is null then null else 'weigh-in' end,
    v_settings.training_weekdays, v_settings.activity_level, v_settings.goal,
    'adaptive-expenditure-v1')
  returning * into v_profile;

  update target_proposals set status = 'approved', decided_at = now(), decided_by = p_user_id
    where id = p_proposal_id returning * into v_prop;
  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, 'target_profiles', v_profile.id::text, v_profile.rev, 'create',
          null, to_jsonb(v_profile));
  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, 'target_proposals', v_prop.id::text, 1, 'update',
          null, to_jsonb(v_prop));
  return jsonb_build_object('status', 'approved', 'target_profile_id', v_profile.id,
                            'profile', to_jsonb(v_profile), 'proposal', to_jsonb(v_prop));
end; $$;
revoke execute on function approve_target_proposal(uuid, uuid) from public, anon;
grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role;
