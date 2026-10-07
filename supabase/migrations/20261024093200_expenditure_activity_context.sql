-- Freeze the activity evidence used by exp-2.0.0 on the estimate and copy it to the proposal.
-- Both tables retain their existing browser read-only/RLS policies; only the service-role RPCs
-- write these columns.
alter table expenditure_estimates add column activity_context jsonb;
alter table target_proposals add column activity_context jsonb;
alter table expenditure_estimates add column learning_days_remaining integer
  check (learning_days_remaining >= 0);

create or replace function upsert_expenditure_estimate(p_user_id uuid, p_row jsonb) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  insert into expenditure_estimates (user_id, local_date, status, tdee_kcal, weight_trend_kg,
      intake_avg_kcal, intake_completeness, qualified_days, weigh_in_count, confidence, reason,
      engine_version, activity_context, learning_days_remaining)
  values (p_user_id, (p_row->>'local_date')::date, p_row->>'status',
      (p_row->>'tdee_kcal')::numeric, (p_row->>'weight_trend_kg')::numeric,
      (p_row->>'intake_avg_kcal')::numeric, (p_row->>'intake_completeness')::numeric,
      (p_row->>'qualified_days')::integer, (p_row->>'weigh_in_count')::integer,
      (p_row->>'confidence')::numeric, p_row->>'reason', p_row->>'engine_version',
      p_row->'activity_context', (p_row->>'learning_days_remaining')::integer)
  on conflict (user_id, local_date) do update set status = excluded.status,
      tdee_kcal = excluded.tdee_kcal, weight_trend_kg = excluded.weight_trend_kg,
      intake_avg_kcal = excluded.intake_avg_kcal,
      intake_completeness = excluded.intake_completeness,
      qualified_days = excluded.qualified_days, weigh_in_count = excluded.weigh_in_count,
      confidence = excluded.confidence, reason = excluded.reason,
      engine_version = excluded.engine_version,
      activity_context = excluded.activity_context,
      learning_days_remaining = excluded.learning_days_remaining
  returning id into v_id;
  return v_id;
end; $$;
revoke execute on function upsert_expenditure_estimate(uuid, jsonb) from public, anon, authenticated;
grant execute on function upsert_expenditure_estimate(uuid, jsonb) to service_role;

create or replace function write_target_proposal(p_user_id uuid, p_week_start date,
    p_based_on_estimate_id uuid, p_proposed jsonb) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_activity_context jsonb;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;

  select activity_context into v_activity_context from expenditure_estimates
    where id = p_based_on_estimate_id and user_id = p_user_id;

  update target_proposals set status = 'rejected', decided_at = now()
    where user_id = p_user_id and status = 'pending' and week_start <> p_week_start;

  insert into target_proposals (
      user_id, week_start, status, based_on_estimate_id, proposed, activity_context)
  values (
      p_user_id, p_week_start, 'pending', p_based_on_estimate_id, p_proposed, v_activity_context)
  on conflict (user_id, week_start) do nothing
  returning id into v_id;

  return v_id;
end; $$;
revoke execute on function write_target_proposal(uuid, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function write_target_proposal(uuid, date, uuid, jsonb) to service_role;
