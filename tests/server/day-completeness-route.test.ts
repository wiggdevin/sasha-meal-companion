/**
 * W142: the wire guard for POST /api/today/day-completeness. Auth comes before the limiter and the
 * model; the strict schema refuses any key beyond the six counts; the body is capped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), limit: vi.fn(), judge: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), requireUser: mocks.auth,
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/server/day-completeness", () => ({ judgeDayCompleteness: mocks.judge }));

const { POST } = await import("@/app/api/today/day-completeness/route");

const GOOD = { isToday: true, localHour: 21, mealsEaten: 1, entryCount: 0, lastEntryHour: 8 };
const req = (body: unknown) => new Request("http://test/api/today/day-completeness", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "u1", client: {} });
  mocks.judge.mockResolvedValue(true);
});

describe("POST /api/today/day-completeness", () => {
  it("answers the verdict for a valid body, rate limited per account", async () => {
    const res = await POST(req(GOOD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nudge: true });
    expect(mocks.limit).toHaveBeenCalledWith("today:day-completeness:u1", 30, 60);
    expect(mocks.judge).toHaveBeenCalledWith(GOOD, "u1");
  });

  it("refuses a signed-out request before the limiter or Jev", async () => {
    mocks.auth.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    expect((await POST(req(GOOD))).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.judge).not.toHaveBeenCalled();
  });

  it("rejects a smuggled name or note with 400 and never reaches Jev", async () => {
    for (const extra of [{ name: "Oats" }, { note: "hurt on 9/12" }, { conditions: ["x"] }]) {
      expect((await POST(req({ ...GOOD, ...extra }))).status).toBe(400);
    }
    expect((await POST(req({ ...GOOD, localHour: 24 }))).status).toBe(400);
    expect(mocks.judge).not.toHaveBeenCalled();
  });

  it("caps the body at 512 bytes", async () => {
    const res = await POST(req({ ...GOOD, padding: "x".repeat(1000) }));
    expect([400, 413]).toContain(res.status);
    expect(mocks.judge).not.toHaveBeenCalled();
  });

  it("passes the limiter's refusal through", async () => {
    mocks.limit.mockRejectedValue(new HttpError(429, "rate_limited", "Slow down."));
    expect((await POST(req(GOOD))).status).toBe(429);
    expect(mocks.judge).not.toHaveBeenCalled();
  });
});
