// tests/proposals/decide-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const decide = vi.fn();
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/proposals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/proposals")>("@/lib/server/proposals");
  return { ...actual, decideProposal: (...a: unknown[]) => decide(...a) };
});
const { POST } = await import("@/app/api/proposals/[id]/decide/route");
const { ProposalConflictError } = await import("@/lib/server/proposals");
const { HttpError } = await import("@/lib/server/auth");

const CURRENT = { id: "pr1", weekStart: "2026-09-14", createdAt: "2026-09-13T21:00:00.000Z",
  status: "approved" as const, basedOnEstimateId: "e1",
  proposed: { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
    deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false } };

const call = (body: unknown, id = "5f1b1a2c-0000-4000-8000-0000000000a1") => POST(
  new Request(`https://x.test/api/proposals/${id}/decide`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) });

beforeEach(() => {
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: {} });
  decide.mockReset().mockResolvedValue({ status: "approved", targetProfileId: "tp1" });
});

describe("POST /api/proposals/[id]/decide", () => {
  it("401s without a session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await call({ decision: "approve", expectedStatus: "pending" })).status).toBe(401);
  });
  it("rate-limits at 30 a minute keyed by the user", async () => {
    await call({ decision: "approve", expectedStatus: "pending" });
    expect(enforceRateLimit).toHaveBeenCalledWith("proposals:decide:u1", 30, 60);
  });
  it("approves and returns the new target_profiles id", async () => {
    const res = await call({ decision: "approve", expectedStatus: "pending" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "approved", targetProfileId: "tp1" });
    expect(decide).toHaveBeenCalledWith({}, "u1", "5f1b1a2c-0000-4000-8000-0000000000a1",
      { decision: "approve", expectedStatus: "pending" });
  });
  it("400s a body missing expectedStatus", async () => {
    expect((await call({ decision: "approve" })).status).toBe(400);
  });
  it("413s a body over 4 KB", async () => {
    expect((await call({ decision: "approve", expectedStatus: "pending",
      pad: "x".repeat(5000) })).status).toBe(413);
  });
  it("409s carrying the current row when it was already decided", async () => {
    decide.mockRejectedValue(new ProposalConflictError(CURRENT));
    const res = await call({ decision: "approve", expectedStatus: "pending" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "conflict", current: { status: "approved" } });
  });
  it("404s another user's proposal id", async () => {
    decide.mockRejectedValue(new HttpError(404, "not_found"));
    expect((await call({ decision: "reject", expectedStatus: "pending" }, "5f1b1a2c-0000-4000-8000-0000000000a9")).status).toBe(404);
  });
});

describe("decide route id check", () => {
  it("answers 400 for a malformed proposal id", async () => {
    const res = await call({ decision: "approve", expectedStatus: "pending" }, "pr1");
    expect(res.status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });
});
