// tests/proposals/rls-decide.test.ts  — [needs branch]
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { decideProposal } from "@/lib/server/proposals";

const run = HAS_BRANCH ? describe : describe.skip;

const PROPOSED = { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
  deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false };

run("target_proposals RLS — a client UPDATE is only a reject", () => {
  let admin: ReturnType<typeof adminClient>;
  let users: Awaited<ReturnType<typeof createTestUsers>>;
  let week = 0;

  const nextWeek = () => `2026-11-${String(2 + (week += 1)).padStart(2, "0")}`;

  async function seed(status = "pending"): Promise<string> {
    const { data, error } = await admin.from("target_proposals").insert({
      user_id: users.a.userId, week_start: nextWeek(), status, proposed: PROPOSED,
    }).select("id").single();
    if (error || !data) throw error ?? new Error("could not seed a proposal");
    return data.id as string;
  }

  beforeAll(async () => {
    admin = adminClient();
    users = await createTestUsers();
    await resetUser(users.a.userId);
    await resetUser(users.b.userId);
  });

  beforeEach(async () => {
    await resetUser(users.a.userId);
  });

  it("rejects a direct client UPDATE that sets status = 'approved'", async () => {
    const id = await seed();
    const { error } = await users.a.client.from("target_proposals")
      .update({ status: "approved" }).eq("id", id).select("id, status");
    expect(error).not.toBeNull();
    const { data } = await admin.from("target_proposals").select("status").eq("id", id).single();
    expect(data?.status).toBe("pending");
  });

  it("rejects a client UPDATE that rewrites proposed, even alongside a reject", async () => {
    const id = await seed();
    const { error } = await users.a.client.from("target_proposals")
      .update({ status: "rejected", decided_by: users.a.userId,
        decided_at: new Date().toISOString(),
        proposed: { ...PROPOSED, kcalTrain: 9999 } })
      .eq("id", id).select("id");
    expect(error).not.toBeNull();
    const { data } = await admin.from("target_proposals")
      .select("status, proposed").eq("id", id).single();
    expect(data?.status).toBe("pending");
    expect((data?.proposed as typeof PROPOSED).kcalTrain).toBe(2250);
  });

  it("allows the narrow reject: pending -> rejected on the caller's own row", async () => {
    const id = await seed();
    const out = await decideProposal(users.a.client, users.a.userId, id,
      { decision: "reject", expectedStatus: "pending" });
    expect(out).toEqual({ status: "rejected", targetProfileId: null });
    const { data } = await admin.from("target_proposals")
      .select("status, decided_by").eq("id", id).single();
    expect(data?.status).toBe("rejected");
    expect(data?.decided_by).toBe(users.a.userId);
  });

  it("still approves in the one security-definer transaction", async () => {
    const id = await seed();
    const out = await decideProposal(users.a.client, users.a.userId, id,
      { decision: "approve", expectedStatus: "pending" });
    expect(out.status).toBe("approved");
    expect(out.targetProfileId).toBeTruthy();
    const { data } = await admin.from("target_proposals").select("status").eq("id", id).single();
    expect(data?.status).toBe("approved");
  });
});
