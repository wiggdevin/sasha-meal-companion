/**
 * Followups #18, `POST /api/onboarding/events`: 202 whatever the insert does, zod refuses any
 * shape that does not match a kind (no answer content, no free text ever reaches the route), a
 * failed insert is logged by error code only, and the per-account rate limit holds. The store's
 * own shape-matching (`onboarding_event_shape_valid`) runs on the local stack in
 * tests/migrations/onboarding-events-db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

// W070: the store writes with the admin client and the session's user id, never the session client.
const { rpc, sessionRpc } = vi.hoisted(() => ({ rpc: vi.fn(), sessionRpc: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ rpc }) }));

const { requireUser } = await import("@/lib/server/auth");
const { POST } = await import("@/app/api/onboarding/events/route");

const USER = "6f1d0c1e-4a52-4c39-9a8e-3b2c1d0e9f11";

function stepEntered(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientEventId: crypto.randomUUID(), at: new Date().toISOString(), flowVersion: "onboarding_v2",
    kind: "step_entered", step: "facts", ...over };
}

function post(body: unknown, raw?: string): Request {
  return new Request("https://app.test/api/onboarding/events", {
    method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimits();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { inserted: 1, duplicates: 0, rejected: 0 }, error: null });
  vi.mocked(requireUser).mockResolvedValue({ userId: USER, client: { rpc: sessionRpc } as never });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the request shape -- no answer content, no free text can reach the route", () => {
  const bad: [string, unknown][] = [
    ["an unknown kind", stepEntered({ kind: "answer_given" })],
    ["a step on a question event", { ...stepEntered({ kind: "question_entered" }), step: "facts", question: undefined }],
    ["a duration on an entered event", { ...stepEntered(), durationMs: 500 }],
    ["a free-text step", stepEntered({ step: "why did you skip breakfast" })],
    ["an unknown field", stepEntered({ note: "the user said they hate eggs" })],
    ["a negative duration", { ...stepEntered({ kind: "step_left" }), durationMs: -1 }],
    ["an oversized duration", { ...stepEntered({ kind: "step_left" }), durationMs: 24 * 60 * 60 * 1000 + 1 }],
    ["an unknown flow version", stepEntered({ flowVersion: "onboarding_v3" })],
    ["more than 20 events", { events: Array.from({ length: 21 }, () => stepEntered()) }],
    ["empty events", { events: [] }],
  ];
  it.each(bad)("refuses %s with 400 and no RPC", async (_, event) => {
    const body = (event as { events?: unknown }).events ? event : { events: [event] };
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("bad_request");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the fixed vocabulary", () => {
  it("accepts a pilot_arm_assigned event", async () => {
    const response = await POST(post({ events: [{ clientEventId: crypto.randomUUID(),
      at: new Date().toISOString(), flowVersion: "onboarding_v2", kind: "pilot_arm_assigned", pilotArm: "treatment" }] }));
    expect(response.status).toBe(202);
    expect(rpc).toHaveBeenCalledWith("record_onboarding_events_for", { p_user_id: USER, p_events: [expect.objectContaining({
      kind: "pilot_arm_assigned", pilot_arm: "treatment", step: null, question: null, duration_ms: null })] });
  });

  it("accepts a question_left event with its duration", async () => {
    const response = await POST(post({ events: [{ clientEventId: crypto.randomUUID(),
      at: new Date().toISOString(), flowVersion: "onboarding_v2", kind: "question_left", question: "goal",
      durationMs: 4200 }] }));
    expect(response.status).toBe(202);
    expect(rpc).toHaveBeenCalledWith("record_onboarding_events_for", { p_user_id: USER, p_events: [expect.objectContaining({
      kind: "question_left", question: "goal", duration_ms: 4200, step: null, pilot_arm: null })] });
  });
});

describe("the insert", () => {
  it("answers 202 with accepted/rejected from the store", async () => {
    rpc.mockResolvedValue({ data: { inserted: 1, duplicates: 1, rejected: 1 }, error: null });
    const response = await POST(post({ events: [stepEntered(), stepEntered(), stepEntered()] }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2, rejected: 1 });
  });

  it("answers 202 and rejects the whole batch (never blocks onboarding) when the insert itself fails, logging only the error code", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "40P01" } });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(post({ events: [stepEntered()] }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 0, rejected: 1 });
    expect(spy).toHaveBeenCalledWith("onboarding events: insert failed; answered 202",
      expect.objectContaining({ code: "40P01" }));
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("facts");
  });
});
