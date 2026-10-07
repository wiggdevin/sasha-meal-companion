-- Phase 6 (contracts §3, spec "Data changes"). Phase 0 already created target_profiles,
-- expenditure_estimates and target_proposals (…000200_user_schema.sql) and gave all three the
-- pattern-1 _rw policy (…000500_rls.sql). This migration adds the week key the weekly job needs,
-- the two counters the ExpenditureResponse carries, the two indexes, and TIGHTENS the two
-- estimator tables to the read-only shape the spec's security table requires. target_profiles
-- keeps its _rw policy: the user authors targets, and every write goes through
-- lib/server/targets.ts so the floors are re-applied server-side.

alter table target_proposals add column week_start date not null;
alter table expenditure_estimates add column qualified_days integer;
alter table expenditure_estimates add column weigh_in_count integer;

create unique index target_proposals_one_per_week on target_proposals (user_id, week_start);
create index expenditure_estimates_recent on expenditure_estimates (user_id, local_date desc);

-- ---------- RLS: read-only to the browser, written only by the privileged boundary (§2.2) ------
drop policy expenditure_estimates_rw on expenditure_estimates;
create policy expenditure_estimates_ro on expenditure_estimates for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on table expenditure_estimates from authenticated;

drop policy target_proposals_rw on target_proposals;
create policy target_proposals_ro on target_proposals for select to authenticated
  using (user_id = (select auth.uid()));
-- The browser's only write is a reject: a still-pending proposal becomes rejected, decided by the
-- caller. Approval runs inside approve_target_proposal (security definer, one transaction, §3.7);
-- the column-level grant keeps `proposed`, the calories and `user_id` out of a direct client PATCH.
create policy target_proposals_decide on target_proposals for update to authenticated
  using (user_id = (select auth.uid()) and status = 'pending')
  with check (user_id = (select auth.uid()) and status = 'rejected'
    and decided_by = (select auth.uid()));
revoke insert, delete, update on table target_proposals from authenticated;
grant update (status, decided_at, decided_by) on table target_proposals to authenticated;

-- ---------- the job lock (Lane P owns job_runs; this is the safety net when P has not landed) --
create table if not exists job_runs (job text not null, run_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check (status in ('running','ok','error')), detail jsonb,
  primary key (job, user_id, run_key));

-- ---------- approval: one transaction, two change_log rows (§3.7) ------------------------------
create function approve_target_proposal(p_user_id uuid, p_proposal_id uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prop     target_proposals%rowtype;
  v_proposed jsonb;
  v_active   target_profiles%rowtype;
  v_profile  target_profiles%rowtype;
  v_seq      bigint;
begin
  perform _sync_assert_caller(p_user_id);

  -- for update serialises two taps on the same proposal: the loser reads status 'approved'.
  select * into v_prop from target_proposals
    where id = p_proposal_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_prop.status <> 'pending' then
    return jsonb_build_object('status', 'conflict', 'current', to_jsonb(v_prop));
  end if;
  v_proposed := v_prop.proposed;

  select * into v_active from target_profiles
    where user_id = p_user_id and effective_from <= current_date
    order by effective_from desc, rev desc limit 1;

  -- The floors, the goal rate and the step cap carry over from the active profile; the engine
  -- never authors a floor of its own (§3.4 "authored floors > approved proposal > engine").
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

-- ---------- the estimate upsert: service_role only (§2.2) --------------------------------------
create function upsert_expenditure_estimate(p_user_id uuid, p_row jsonb) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  insert into expenditure_estimates (user_id, local_date, status, tdee_kcal, weight_trend_kg,
      intake_avg_kcal, intake_completeness, qualified_days, weigh_in_count, confidence, reason,
      engine_version)
  values (p_user_id, (p_row->>'local_date')::date, p_row->>'status',
      (p_row->>'tdee_kcal')::numeric, (p_row->>'weight_trend_kg')::numeric,
      (p_row->>'intake_avg_kcal')::numeric, (p_row->>'intake_completeness')::numeric,
      (p_row->>'qualified_days')::integer, (p_row->>'weigh_in_count')::integer,
      (p_row->>'confidence')::numeric, p_row->>'reason', p_row->>'engine_version')
  on conflict (user_id, local_date) do update set status = excluded.status,
      tdee_kcal = excluded.tdee_kcal, weight_trend_kg = excluded.weight_trend_kg,
      intake_avg_kcal = excluded.intake_avg_kcal,
      intake_completeness = excluded.intake_completeness,
      qualified_days = excluded.qualified_days, weigh_in_count = excluded.weigh_in_count,
      confidence = excluded.confidence, reason = excluded.reason,
      engine_version = excluded.engine_version
  returning id into v_id;
  return v_id;
end; $$;
revoke execute on function upsert_expenditure_estimate(uuid, jsonb) from public, anon, authenticated;
grant execute on function upsert_expenditure_estimate(uuid, jsonb) to service_role;
