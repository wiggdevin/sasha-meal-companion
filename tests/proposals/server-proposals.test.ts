import { describe, expect, it, vi } from "vitest";
import { decideProposal, listProposals, ProposalConflictError } from "@/lib/server/proposals";

const PROPOSED = { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
  deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false };
const ROW = { id: "pr1", week_start: "2026-09-14", created_at: "2026-09-13T21:00:00.000Z",
  status: "pending", based_on_estimate_id: "e1", proposed: PROPOSED };

function clientWith(rows: Record<string, unknown>[], rpcResult: unknown, updated: unknown = ROW) {
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult, error: null });
  const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: () => ({
    select: () => ({ maybeSingle: async () => ({ data: updated, error: null }) }) }) }) }) }));
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ eq: () => ({
      order: async () => ({ data: rows, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }) }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      order: async () => ({ data: rows, error: null }) }) }),
    update,
  }));
  return { client: { from, rpc } as never, rpc, update };
}

describe("listProposals", () => {
  it("maps rows onto the wire type", async () => {
    const { client } = clientWith([ROW], null);
    await expect(listProposals(client, "u1", "pending")).resolves.toEqual([{
      id: "pr1", weekStart: "2026-09-14", createdAt: "2026-09-13T21:00:00.000Z",
      status: "pending", basedOnEstimateId: "e1", proposed: PROPOSED }]);
  });
});

describe("decideProposal — approve", () => {
  it("runs the one-transaction RPC and returns the new profile id", async () => {
    const { client, rpc } = clientWith([ROW],
      { status: "approved", target_profile_id: "tp1" });
    await expect(decideProposal(client, "u1", "pr1",
      { decision: "approve", expectedStatus: "pending" }))
      .resolves.toEqual({ status: "approved", targetProfileId: "tp1" });
    expect(rpc).toHaveBeenCalledWith("approve_target_proposal",
      { p_user_id: "u1", p_proposal_id: "pr1" });
  });

  it("raises 409 carrying the current row when it was already decided", async () => {
    const { client } = clientWith([ROW],
      { status: "conflict", current: { ...ROW, status: "approved" } });
    const call = decideProposal(client, "u1", "pr1",
      { decision: "approve", expectedStatus: "pending" });
    await expect(call).rejects.toBeInstanceOf(ProposalConflictError);
    await call.catch((e: ProposalConflictError) => {
      expect(e.status).toBe(409);
      expect(e.current.status).toBe("approved");
    });
  });

  it("404s another user's proposal id — RLS makes it invisible", async () => {
    const { client } = clientWith([], { status: "not_found" });
    await expect(decideProposal(client, "u1", "pr9",
      { decision: "approve", expectedStatus: "pending" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("decideProposal — reject", () => {
  it("writes no profile and updates only a row still in expectedStatus", async () => {
    const { client, update, rpc } = clientWith([ROW], null, { ...ROW, status: "rejected" });
    await expect(decideProposal(client, "u1", "pr1",
      { decision: "reject", expectedStatus: "pending" }))
      .resolves.toEqual({ status: "rejected", targetProfileId: null });
    expect(rpc).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", decided_by: "u1" }));
  });

  it("409s when the CAS update matches nothing but the row exists", async () => {
    const { client } = clientWith([{ ...ROW, status: "approved" }], null, null);
    await expect(decideProposal(client, "u1", "pr1",
      { decision: "reject", expectedStatus: "pending" })).rejects.toBeInstanceOf(ProposalConflictError);
  });
});
