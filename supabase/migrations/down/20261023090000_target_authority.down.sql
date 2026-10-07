-- Restore the Phase 6 approval function before removing the columns its U1 replacement reads.
create or replace function approve_target_proposal(p_user_id uuid, p_proposal_id uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prop     target_proposals%rowtype;
  v_proposed jsonb;
  v_active   target_profiles%rowtype;
  v_profile  target_profiles%rowtype;
  v_seq      bigint;
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
  insert into target_profiles (user_id, effective_from, rev, kcal_train, kcal_rest, authored_by,
      mode, protein_g, fat_g, carb_g, kcal_min, protein_g_min, fat_g_min, carb_g_min,
      goal_rate_bp_week, max_weekly_kcal_step, notes)
  values (p_user_id, coalesce(v_prop.week_start, current_date), 1,
      (v_proposed->>'kcalTrain')::integer, (v_proposed->>'kcalRest')::integer, 'engine_proposal',
      'grams', (v_proposed->>'proteinG')::numeric, (v_proposed->>'fatG')::numeric,
      (v_proposed->>'carbG')::numeric,
      coalesce(v_active.kcal_min, 1650),
      coalesce(v_active.protein_g_min, (v_proposed->>'proteinG')::numeric),
      coalesce(v_active.fat_g_min, 50), coalesce(v_active.carb_g_min, 0),
      coalesce(v_active.goal_rate_bp_week, 0), coalesce(v_active.max_weekly_kcal_step, 150),
      'Approved from proposal ' || p_proposal_id::text)
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

drop function if exists write_target_revision(uuid, jsonb);

alter table target_profiles
  drop column target_source,
  drop column training_macros,
  drop column rest_macros,
  drop column pin_training_kcal,
  drop column pin_rest_kcal,
  drop column pin_protein_g,
  drop column input_weight_kg,
  drop column input_weight_source,
  drop column input_training_weekdays,
  drop column input_activity_level,
  drop column input_goal,
  drop column formula_name;
