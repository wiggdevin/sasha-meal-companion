-- A first app-authored target needs an Undo predecessor, but both rows must commit together.
-- request_id also makes a queued retry safe when the first HTTP response was lost after commit.
create or replace function write_target_revision(p_user_id uuid, p_row jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_profile target_profiles%rowtype;
  v_training jsonb := p_row->'training_macros';
  v_rest jsonb := p_row->'rest_macros';
  v_request_id uuid := nullif(p_row->>'request_id', '')::uuid;
  v_existing jsonb;
  v_rev integer;
  v_seq bigint;
begin
  perform _sync_assert_caller(p_user_id);
  if v_training is null or v_rest is null then
    raise exception 'target_macros_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  if v_request_id is not null then
    select current into v_existing from change_log
      where user_id = p_user_id and entity = 'target_profiles' and op_id = v_request_id;
    if found then return v_existing; end if;
  end if;
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
          v_request_id, to_jsonb(v_profile));
  return to_jsonb(v_profile);
end; $$;

create function write_target_revision_pair(
  p_user_id uuid, p_predecessor jsonb, p_row jsonb
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_predecessor jsonb;
  v_revision jsonb;
begin
  perform _sync_assert_caller(p_user_id);
  v_predecessor := write_target_revision(p_user_id, p_predecessor);
  v_revision := write_target_revision(p_user_id, p_row);
  return jsonb_build_object('predecessor', v_predecessor, 'revision', v_revision);
end; $$;

revoke execute on function write_target_revision_pair(uuid, jsonb, jsonb) from public, anon;
grant execute on function write_target_revision_pair(uuid, jsonb, jsonb)
  to authenticated, service_role;
