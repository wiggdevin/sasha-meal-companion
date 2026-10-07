// tests/expenditure/migration.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UP = readFileSync("supabase/migrations/20261006090100_phase6_expenditure.sql", "utf8");
const DOWN = readFileSync("supabase/migrations/down/20261006090100_phase6_expenditure.down.sql", "utf8");

describe("20261006090100_phase6_expenditure.sql", () => {
  it("replaces Phase 0's _rw policies on both estimator tables", () => {
    expect(UP).toContain("drop policy expenditure_estimates_rw on expenditure_estimates");
    expect(UP).toContain("drop policy target_proposals_rw on target_proposals");
    expect(UP).toContain("create policy expenditure_estimates_ro on expenditure_estimates for select to authenticated");
    expect(UP).toContain("create policy target_proposals_ro on target_proposals for select to authenticated");
    expect(UP).toContain("create policy target_proposals_decide on target_proposals for update to authenticated");
  });

  it("revokes the writes the browser must not hold", () => {
    expect(UP).toContain("revoke insert, update, delete on table expenditure_estimates from authenticated");
    expect(UP).toContain("revoke insert, delete, update on table target_proposals from authenticated");
  });

  it("narrows a browser UPDATE to pending -> rejected on three columns only", () => {
    // Approval and any rewrite of `proposed` are the transaction's job, not a client PATCH.
    expect(UP).toContain("grant update (status, decided_at, decided_by) on table target_proposals to authenticated");
    expect(UP).toContain("using (user_id = (select auth.uid()) and status = 'pending')");
    expect(UP).toContain("with check (user_id = (select auth.uid()) and status = 'rejected'");
    expect(UP).toContain("and decided_by = (select auth.uid())");
  });

  it("leaves target_profiles alone — Phase 0 owns it and the user authors targets", () => {
    expect(UP).not.toContain("drop policy target_profiles_rw");
    expect(UP).not.toContain("alter table target_profiles");
  });

  it("grants approve to authenticated and the estimate upsert to service_role only", () => {
    expect(UP).toContain("grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role");
    expect(UP).toContain("revoke execute on function upsert_expenditure_estimate(uuid, jsonb) from public, anon, authenticated");
    expect(UP).toContain("grant execute on function upsert_expenditure_estimate(uuid, jsonb) to service_role");
  });

  it("guards the approve function with _sync_assert_caller and writes two change_log rows", () => {
    expect(UP).toContain("perform _sync_assert_caller(p_user_id)");
    expect(UP.match(/next_change_seq\(p_user_id\)/g) ?? []).toHaveLength(2);
    expect(UP.match(/insert into change_log/g) ?? []).toHaveLength(2);
    expect(UP).toContain("'engine_proposal'");
  });

  it("adds the week key, the two counters and both indexes", () => {
    expect(UP).toContain("alter table target_proposals add column week_start date");
    expect(UP).toContain("add column qualified_days integer");
    expect(UP).toContain("add column weigh_in_count integer");
    expect(UP).toContain("create unique index target_proposals_one_per_week on target_proposals (user_id, week_start)");
    expect(UP).toContain("create index expenditure_estimates_recent on expenditure_estimates (user_id, local_date desc)");
  });

  it("down drops only what up created and restores both _rw policies", () => {
    expect(DOWN).toContain("drop function if exists approve_target_proposal(uuid, uuid)");
    expect(DOWN).toContain("drop function if exists upsert_expenditure_estimate(uuid, jsonb)");
    expect(DOWN).toContain("revoke update (status, decided_at, decided_by) on table target_proposals from authenticated");
    expect(DOWN).toContain("create policy expenditure_estimates_rw on expenditure_estimates for all to authenticated");
    expect(DOWN).toContain("create policy target_proposals_rw on target_proposals for all to authenticated");
    expect(DOWN).not.toContain("drop table");
  });
});
