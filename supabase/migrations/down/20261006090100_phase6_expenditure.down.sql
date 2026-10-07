-- Reverses 20261006090100 exactly. It drops no table: expenditure_estimates, target_proposals and
-- target_profiles are Phase 0's, and an approved profile survives as an ordinary authored row
-- (spec "Rollout and rollback"). job_runs is Lane P's table and is left in place.
drop function if exists approve_target_proposal(uuid, uuid);
drop function if exists upsert_expenditure_estimate(uuid, jsonb);

drop policy if exists target_proposals_decide on target_proposals;
drop policy if exists target_proposals_ro on target_proposals;
create policy target_proposals_rw on target_proposals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke update (status, decided_at, decided_by) on table target_proposals from authenticated;
grant select, insert, update, delete on table target_proposals to authenticated;

drop policy if exists expenditure_estimates_ro on expenditure_estimates;
create policy expenditure_estimates_rw on expenditure_estimates for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on table expenditure_estimates to authenticated;

drop index if exists expenditure_estimates_recent;
drop index if exists target_proposals_one_per_week;
alter table expenditure_estimates drop column if exists weigh_in_count;
alter table expenditure_estimates drop column if exists qualified_days;
alter table target_proposals drop column if exists week_start;
