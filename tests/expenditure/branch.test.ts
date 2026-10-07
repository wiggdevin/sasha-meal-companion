// tests/expenditure/branch.test.ts  — [needs branch]
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { ensureJobRuns } from "./job-runs-fixture";

const run = HAS_BRANCH ? describe : describe.skip;

run("the weekly job on a real branch", () => {
  let userId = "";
  let admin: ReturnType<typeof adminClient>;

  beforeAll(async () => {
    ensureJobRuns();
    admin = adminClient();
    const users = await createTestUsers();
    userId = users.a.userId;
    await resetUser(userId);
    process.env.CRON_SECRET = "branch-secret";
    process.env.ESTIMATOR_ENABLED = "1";
  });

  async function seedEstimating(weekStart: string) {
    await admin.rpc("upsert_expenditure_estimate", { p_user_id: userId, p_row: {
      local_date: weekStart, status: "estimating", tdee_kcal: 2250, weight_trend_kg: 57.4,
      intake_avg_kcal: 2200, intake_completeness: 1, qualified_days: 21, weigh_in_count: 21,
      confidence: 1, reason: null, engine_version: "exp-1.0.0" } });
  }

  it("upserts one estimate per user and local date (acceptance criterion 5's sibling)", async () => {
    await seedEstimating("2026-09-14");
    await seedEstimating("2026-09-14");
    const { data } = await admin.from("expenditure_estimates").select("id")
      .eq("user_id", userId).eq("local_date", "2026-09-14");
    expect(data).toHaveLength(1);
  });

  it("refuses a browser insert into expenditure_estimates (acceptance criterion 13)", async () => {
    const users = await createTestUsers();
    const { error } = await users.a.client.from("expenditure_estimates")
      .insert({ user_id: userId, local_date: "2026-09-15", status: "estimating",
        engine_version: "exp-1.0.0" });
    expect(error).not.toBeNull();
  });

  it("refuses the service-role-only estimate upsert from a browser session", async () => {
    const users = await createTestUsers();
    const { error } = await users.a.client.rpc("upsert_expenditure_estimate",
      { p_user_id: userId, p_row: { local_date: "2026-09-16", status: "estimating",
        engine_version: "exp-1.0.0" } });
    expect(error).not.toBeNull();
  });

  it("persists activity provenance, copies it to proposals, and preserves cross-user denial", async () => {
    const users = await createTestUsers();
    const activityContext = {
      version: "activity-1.0.0", asOf: "2026-09-17", timeZone: "America/Denver",
      currentStepsAvg: 4_800, currentDays: 7, baselineStepsAvg: 8_000, baselineDays: 28,
      deviationPct: -0.4, band: "lower", activeKcal7dAvg: 300, activeKcalDays: 7,
      residualKcal: -122, smoothing: "corroborated", targetAdjustmentKcal: 0,
    };
    const { data: estimateId, error: estimateError } = await admin.rpc(
      "upsert_expenditure_estimate",
      { p_user_id: userId, p_row: {
        local_date: "2026-09-17", status: "estimating", tdee_kcal: 1960,
        weight_trend_kg: 57.4, intake_avg_kcal: 2130, intake_completeness: 1,
        qualified_days: 21, weigh_in_count: 21, confidence: 1, reason: null,
        engine_version: "exp-2.0.0", activity_context: activityContext,
        learning_days_remaining: 0,
      } },
    );
    expect(estimateError).toBeNull();

    const { data: ownRows } = await users.a.client.from("expenditure_estimates")
      .select("activity_context, learning_days_remaining").eq("id", estimateId);
    expect(ownRows?.[0]).toEqual({ activity_context: activityContext, learning_days_remaining: 0 });
    const { data: otherRows } = await users.b.client.from("expenditure_estimates")
      .select("id").eq("id", estimateId);
    expect(otherRows).toEqual([]);
    const { error: rewriteError } = await users.a.client.from("expenditure_estimates")
      .update({ activity_context: { ...activityContext, band: "higher" } }).eq("id", estimateId);
    expect(rewriteError).not.toBeNull();

    const proposed = { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
      deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false };
    const { data: proposalId, error: proposalError } = await admin.rpc("write_target_proposal", {
      p_user_id: userId, p_week_start: "2026-12-07",
      p_based_on_estimate_id: estimateId, p_proposed: proposed,
    });
    expect(proposalError).toBeNull();
    const { data: proposal } = await admin.from("target_proposals")
      .select("activity_context").eq("id", proposalId).single();
    expect(proposal?.activity_context).toEqual(activityContext);
    const { data: hiddenProposal } = await users.b.client.from("target_proposals")
      .select("id").eq("id", proposalId);
    expect(hiddenProposal).toEqual([]);
    await admin.from("target_proposals").update({ status: "rejected", decided_at: new Date().toISOString() })
      .eq("id", proposalId);
  });

  it("writes exactly one proposal per user and week (acceptance criterion 5)", async () => {
    const row = { user_id: userId, week_start: "2026-09-21", status: "pending",
      proposed: { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
        deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false } };
    expect((await admin.from("target_proposals").insert(row)).error).toBeNull();
    expect((await admin.from("target_proposals").insert(row)).error?.code).toBe("23505");
  });
});
