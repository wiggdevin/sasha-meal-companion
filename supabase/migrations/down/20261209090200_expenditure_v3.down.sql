-- Reverse of 20261209090200_expenditure_v3.sql: the previous upsert body (from
-- 20261024093200_expenditure_activity_context.sql), then the columns. exp-3.0.0 rows keep their
-- tdee_kcal and status; only the v3 fields are dropped.
do $refuse$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and exists (select 1 from expenditure_estimates where phase is not null) then
    raise exception 'expenditure_v3 down: exp-3.0.0 rows hold phase and range data; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end;
$refuse$;

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

alter table public.expenditure_estimates
  drop column fluid_cycle_days,
  drop column review_flag,
  drop column proposal_eligible,
  drop column seed_source,
  drop column data_weight,
  drop column tdee_high_kcal,
  drop column tdee_low_kcal,
  drop column phase;
