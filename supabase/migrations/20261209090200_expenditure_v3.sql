-- TDEE step E, engine exp-3.1.0 (docs/specs/phase-16-adaptive-handoff.md, rulings R1–R9):
-- the estimate row records its phase, its empirical range, the data weight, where its seed came
-- from, whether a proposal may be made, and any review flag. All nullable: older rows keep null
-- and keep their own engine_version; nothing is recomputed.
alter table public.expenditure_estimates
  add column phase text
    constraint expenditure_estimates_phase_check check (phase in ('starting', 'provisional', 'adaptive')),
  add column tdee_low_kcal numeric,
  add column tdee_high_kcal numeric,
  add column data_weight numeric
    constraint expenditure_estimates_data_weight_range check (data_weight between 0 and 1),
  add column seed_source text
    constraint expenditure_estimates_seed_source_check check (seed_source in ('revision', 'live_profile')),
  add column proposal_eligible boolean,
  add column review_flag text
    constraint expenditure_estimates_review_flag_check check (review_flag in ('far_from_seed', 'bmr_bounds')),
  add column fluid_cycle_days integer
    constraint expenditure_estimates_fluid_cycle_days_range check (fluid_cycle_days between 20 and 40);

create or replace function public.upsert_expenditure_estimate(p_user_id uuid, p_row jsonb)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  insert into expenditure_estimates (user_id, local_date, status, tdee_kcal, weight_trend_kg,
      intake_avg_kcal, intake_completeness, qualified_days, weigh_in_count, confidence, reason,
      engine_version, activity_context, learning_days_remaining, phase, tdee_low_kcal,
      tdee_high_kcal, data_weight, seed_source, proposal_eligible, review_flag, fluid_cycle_days)
  values (p_user_id, (p_row->>'local_date')::date, p_row->>'status',
      (p_row->>'tdee_kcal')::numeric, (p_row->>'weight_trend_kg')::numeric,
      (p_row->>'intake_avg_kcal')::numeric, (p_row->>'intake_completeness')::numeric,
      (p_row->>'qualified_days')::integer, (p_row->>'weigh_in_count')::integer,
      (p_row->>'confidence')::numeric, p_row->>'reason', p_row->>'engine_version',
      p_row->'activity_context', (p_row->>'learning_days_remaining')::integer,
      p_row->>'phase', (p_row->>'tdee_low_kcal')::numeric, (p_row->>'tdee_high_kcal')::numeric,
      (p_row->>'data_weight')::numeric, p_row->>'seed_source',
      (p_row->>'proposal_eligible')::boolean, p_row->>'review_flag',
      (p_row->>'fluid_cycle_days')::integer)
  on conflict (user_id, local_date) do update set status = excluded.status,
      tdee_kcal = excluded.tdee_kcal, weight_trend_kg = excluded.weight_trend_kg,
      intake_avg_kcal = excluded.intake_avg_kcal,
      intake_completeness = excluded.intake_completeness,
      qualified_days = excluded.qualified_days, weigh_in_count = excluded.weigh_in_count,
      confidence = excluded.confidence, reason = excluded.reason,
      engine_version = excluded.engine_version,
      activity_context = excluded.activity_context,
      learning_days_remaining = excluded.learning_days_remaining,
      phase = excluded.phase, tdee_low_kcal = excluded.tdee_low_kcal,
      tdee_high_kcal = excluded.tdee_high_kcal, data_weight = excluded.data_weight,
      seed_source = excluded.seed_source, proposal_eligible = excluded.proposal_eligible,
      review_flag = excluded.review_flag, fluid_cycle_days = excluded.fluid_cycle_days
  returning id into v_id;
  return v_id;
end; $$;
revoke execute on function upsert_expenditure_estimate(uuid, jsonb) from public, anon, authenticated;
grant execute on function upsert_expenditure_estimate(uuid, jsonb) to service_role;
