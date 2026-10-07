import { beforeEach, describe, expect, it, vi } from "vitest";
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const latestEstimate = vi.fn();
const weightTrendSeries = vi.fn();
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/expenditure", () => ({
  latestEstimate: (...a: unknown[]) => latestEstimate(...a),
  weightTrendSeries: (...a: unknown[]) => weightTrendSeries(...a),
}));
const { GET } = await import("@/app/api/expenditure/route");
const { HttpError } = await import("@/lib/server/auth");

beforeEach(() => {
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: {} });
  latestEstimate.mockReset().mockResolvedValue({ status: "burn_in", tdeeKcal: null });
  weightTrendSeries.mockReset().mockResolvedValue([]);
});

describe("GET /api/expenditure", () => {
  it("401s without a session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await GET(new Request("https://x.test/api/expenditure"))).status).toBe(401);
  });
  it("rate-limits at 60 a minute keyed by the user, after identity", async () => {
    await GET(new Request("https://x.test/api/expenditure"));
    expect(enforceRateLimit).toHaveBeenCalledWith("expenditure:user:u1", 60, 60);
  });
  it("answers 200 with burn_in and nulls rather than 404", async () => {
    const res = await GET(new Request("https://x.test/api/expenditure"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "burn_in", tdeeKcal: null });
  });

  /* Design §8.2: `/body` draws the weight-trend line from stored rows, so the body response is
     where the series is exposed — scoped to the signed-in user, like every other read here. */
  it("carries the dated weight-trend series for the signed-in user", async () => {
    weightTrendSeries.mockResolvedValue([57.9, null, 57.6]);
    const res = await GET(new Request("https://x.test/api/expenditure"));
    expect(weightTrendSeries).toHaveBeenCalledWith({}, "u1");
    await expect(res.json()).resolves
      .toMatchObject({ weightTrendSeriesKg: [57.9, null, 57.6] });
  });

  it("still answers when the account has no estimate rows to plot", async () => {
    const res = await GET(new Request("https://x.test/api/expenditure"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ weightTrendSeriesKg: [] });
  });
});
