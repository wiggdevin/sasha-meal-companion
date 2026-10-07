import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UP = readFileSync(
  "supabase/migrations/20261024093200_expenditure_activity_context.sql", "utf8",
);
const DOWN = readFileSync(
  "supabase/migrations/down/20261024093200_expenditure_activity_context.down.sql", "utf8",
);

describe("expenditure activity-context migration", () => {
  it("adds nullable provenance to estimates and proposals plus persisted learning progress", () => {
    expect(UP).toContain("expenditure_estimates add column activity_context jsonb");
    expect(UP).toContain("target_proposals add column activity_context jsonb");
    expect(UP).toContain("expenditure_estimates add column learning_days_remaining integer");
    expect(UP).toContain("check (learning_days_remaining >= 0)");
  });

  it("keeps both write RPCs service-only and copies estimate provenance into the proposal", () => {
    expect(UP).toContain("revoke execute on function upsert_expenditure_estimate(uuid, jsonb) from public, anon, authenticated");
    expect(UP).toContain("grant execute on function upsert_expenditure_estimate(uuid, jsonb) to service_role");
    expect(UP).toContain("revoke execute on function write_target_proposal(uuid, date, uuid, jsonb) from public, anon, authenticated");
    expect(UP).toContain("grant execute on function write_target_proposal(uuid, date, uuid, jsonb) to service_role");
    expect(UP).toMatch(/select activity_context[\s\S]*from expenditure_estimates[\s\S]*user_id = p_user_id/);
  });

  it("does not weaken the existing browser policies or column-level proposal grant", () => {
    expect(UP).not.toMatch(/grant\s+(?:insert|delete)\s+on\s+table\s+(?:expenditure_estimates|target_proposals)\s+to\s+authenticated/i);
    expect(UP).not.toContain("grant update (activity_context)");
  });

  it("restores the prior RPC bodies before dropping the additive columns", () => {
    expect(DOWN).toContain("create or replace function upsert_expenditure_estimate");
    expect(DOWN).toContain("create or replace function write_target_proposal");
    expect(DOWN).toContain("drop column if exists activity_context");
    expect(DOWN).toContain("drop column if exists learning_days_remaining");
  });
});
