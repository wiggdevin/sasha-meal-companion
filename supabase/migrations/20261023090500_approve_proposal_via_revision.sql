-- Keep proposal approval on the single target revision writer so its floors, revision number and
-- target_profiles change-feed row cannot drift from app-authored revisions.
create or replace function approve_target_proposal(p_user_id uuid, p_proposal_id uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prop target_proposals%rowtype;
  v_proposed jsonb;
  v_active target_profiles%rowtype;
  v_profile target_profiles%rowtype;
  v_estimate expenditure_estimates%rowtype;
  v_settings user_settings%rowtype;
  v_payload jsonb;
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
  v_rest_carbs := round(((v_proposed->>'kcalRest')::numeric
    - 4 * (v_proposed->>'proteinG')::numeric
    - 9 * (v_proposed->>'fatG')::numeric) / 4);

  v_payload := jsonb_build_object(
    'effective_from', coalesce(v_prop.week_start, current_date),
    'target_source', 'proposal',
    'mode', 'grams',
    'training_macros', jsonb_build_object(
      'kcal', (v_proposed->>'kcalTrain')::integer,
      'protein', (v_proposed->>'proteinG')::numeric,
      'carbs', (v_proposed->>'carbG')::numeric,
      'fat', (v_proposed->>'fatG')::numeric),
    'rest_macros', jsonb_build_object(
      'kcal', (v_proposed->>'kcalRest')::integer,
      'protein', (v_proposed->>'proteinG')::numeric,
      'carbs', v_rest_carbs,
      'fat', (v_proposed->>'fatG')::numeric),
    'pin_training_kcal', null,
    'pin_rest_kcal', null,
    'pin_protein_g', null,
    'input_weight_kg', v_estimate.weight_trend_kg,
    'input_weight_source',
      case when v_estimate.weight_trend_kg is null then null else 'weigh-in' end,
    'input_training_weekdays', v_settings.training_weekdays,
    'input_activity_level', v_settings.activity_level,
    'input_goal', v_settings.goal,
    'formula_name', 'adaptive-expenditure-v1',
    'kcal_min', coalesce(v_active.kcal_min, 1650),
    'protein_g_min', coalesce(v_active.protein_g_min,
      (v_proposed->>'proteinG')::numeric),
    'fat_g_min', coalesce(v_active.fat_g_min, 50),
    'carb_g_min', coalesce(v_active.carb_g_min, 100),
    'goal_rate_bp_week', coalesce(v_active.goal_rate_bp_week, 0),
    'max_weekly_kcal_step', coalesce(v_active.max_weekly_kcal_step, 150),
    'notes', 'Approved from proposal ' || p_proposal_id::text);

  v_profile := jsonb_populate_record(
    null::target_profiles, write_target_revision(p_user_id, v_payload));

  update target_proposals set status = 'approved', decided_at = now(), decided_by = p_user_id
    where id = p_proposal_id returning * into v_prop;
  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, 'target_proposals', v_prop.id::text, 1, 'update',
          null, to_jsonb(v_prop));
  return jsonb_build_object('status', 'approved', 'target_profile_id', v_profile.id,
                            'profile', to_jsonb(v_profile), 'proposal', to_jsonb(v_prop));
end; $$;
revoke execute on function approve_target_proposal(uuid, uuid) from public, anon;
grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role;
