// tests/proposals/branch-decide.test.ts  — [needs branch]
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { decideProposal, ProposalConflictError } from "@/lib/server/proposals";
import { activeTargets, today } from "@/lib/server/targets";

const run = HAS_BRANCH ? describe : describe.skip;

run("approve_target_proposal on a real branch", () => {
  let admin: ReturnType<typeof adminClient>;
  let users: Awaited<ReturnType<typeof createTestUsers>>;
  let proposalId = "";

  const PROPOSED = { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
    deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false };

  beforeAll(async () => {
    admin = adminClient();
    users = await createTestUsers();
    await resetUser(users.a.userId);
    await resetUser(users.b.userId);
    await admin.from("target_profiles").insert({ user_id: users.a.userId,
      effective_from: "2026-09-01", kcal_train: 2200, kcal_rest: 1750, authored_by: "user",
      mode: "grams", protein_g: 135, fat_g: 85, carb_g: 200, protein_g_min: 135 });
    const { data } = await admin.from("target_proposals").insert({ user_id: users.a.userId,
      week_start: today(), status: "pending", proposed: PROPOSED }).select("id").single();
    proposalId = data?.id as string;
  });

  it("approves in one transaction: one profile, two change_log rows (criteria 6 and 7)", async () => {
    const before = await activeTargets(users.a.client, users.a.userId);
    expect(before?.resolved.training.kcal).toBe(2200);      // criterion 6: unchanged until approval

    const out = await decideProposal(users.a.client, users.a.userId, proposalId,
      { decision: "approve", expectedStatus: "pending" });
    expect(out.status).toBe("approved");

    const { data: profiles } = await admin.from("target_profiles")
      .select("id, authored_by").eq("user_id", users.a.userId).eq("authored_by", "engine_proposal");
    expect(profiles).toHaveLength(1);

    const { data: log } = await admin.from("change_log").select("entity, seq")
      .eq("user_id", users.a.userId).in("entity", ["target_profiles", "target_proposals"])
      .order("seq", { ascending: true });
    expect(log?.map((r) => r.entity)).toEqual(["target_profiles", "target_proposals"]);
    expect((log?.[1].seq as number) - (log?.[0].seq as number)).toBe(1);
  });

  it("409s on a second approve and writes nothing more (criterion 7)", async () => {
    await expect(decideProposal(users.a.client, users.a.userId, proposalId,
      { decision: "approve", expectedStatus: "pending" }))
      .rejects.toBeInstanceOf(ProposalConflictError);
    const { data } = await admin.from("target_profiles").select("id")
      .eq("user_id", users.a.userId).eq("authored_by", "engine_proposal");
    expect(data).toHaveLength(1);
  });

  it("404s for another user's proposal id and changes nothing (criterion 13)", async () => {
    await expect(decideProposal(users.b.client, users.b.userId, proposalId,
      { decision: "approve", expectedStatus: "pending" })).rejects.toMatchObject({ status: 404 });
    const { data } = await admin.from("target_profiles").select("id").eq("user_id", users.b.userId);
    expect(data).toHaveLength(0);
  });

  it("changes what GET /api/targets returns and nothing else", async () => {
    const after = await activeTargets(users.a.client, users.a.userId);
    expect(after?.resolved.training.kcal).toBe(2250);
    expect(after?.resolved.training.protein).toBe(135);      // criterion 8: protein never moves
  });
  it("approves a proposal built on a trend weight and records it as 'trend' (PR #241 r1)", async () => {
    const { data: estimate, error: estimateError } = await admin.from("expenditure_estimates")
      .insert({ user_id: users.a.userId, local_date: "2026-09-12", status: "estimating",
        tdee_kcal: 2250, confidence: 1, engine_version: "exp-1.0.0", weight_trend_kg: 80.4 })
      .select("id").single();
    expect(estimateError).toBeNull();
    const { data: proposal, error: proposalError } = await admin.from("target_proposals")
      .insert({ user_id: users.a.userId, week_start: "2099-01-05", status: "pending",
        proposed: PROPOSED, based_on_estimate_id: estimate?.id }).select("id").single();
    expect(proposalError).toBeNull();

    const out = await decideProposal(users.a.client, users.a.userId, proposal?.id as string,
      { decision: "approve", expectedStatus: "pending" });
    expect(out.status).toBe("approved");
    // W006: the approval is dated on the account's own day, not the proposal's week_start.
    const { data: row } = await admin.from("target_profiles")
      .select("input_weight_kg, input_weight_source").eq("user_id", users.a.userId)
      .order("effective_from", { ascending: false }).order("rev", { ascending: false }).limit(1).single();
    expect(row).toMatchObject({ input_weight_source: "trend" });
    expect(Number(row?.input_weight_kg)).toBeCloseTo(80.4);
  });
});
