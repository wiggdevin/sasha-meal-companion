import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  afterCallbacks: [] as (() => unknown)[],
  requireUser: vi.fn(),
  warmEatsFacets: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ service: true }) }));
vi.mock("@/lib/server/eats-facet-warm", () => ({ warmEatsFacets: mocks.warmEatsFacets }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: mocks.requireUser,
}));

const { POST } = await import("@/app/api/foods/facets/warm/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

function req(): Request {
  return new Request("https://app.test/api/foods/facets/warm", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  mocks.afterCallbacks.length = 0;
  mocks.after.mockImplementation((callback: () => unknown) => { mocks.afterCallbacks.push(callback); });
  mocks.requireUser.mockResolvedValue({ userId: "user-1", client: {} });
  mocks.warmEatsFacets.mockResolvedValue({ foods: 0, warmed: 0, skipped: 0, errors: 0,
    stoppedEarly: false });
});

describe("POST /api/foods/facets/warm", () => {
  it("answers 202 before the warm has even started", async () => {
    const response = await POST(req());
    expect(response.status).toBe(202);
    expect(mocks.warmEatsFacets).not.toHaveBeenCalled();
  });

  it("warms the caller's own Eats list in afterResponse, capped at 10", async () => {
    await POST(req());
    expect(mocks.afterCallbacks).toHaveLength(1);
    await mocks.afterCallbacks[0]();
    expect(mocks.warmEatsFacets).toHaveBeenCalledWith({ service: true }, "user-1", { maxFoods: 10 });
  });

  it("401s with no warm scheduled when the caller is not signed in", async () => {
    const { HttpError } = await import("@/lib/server/auth");
    mocks.requireUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    const response = await POST(req());
    expect(response.status).toBe(401);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it("rate-limits a burst of marks past six an hour", async () => {
    for (let i = 0; i < 6; i += 1) expect((await POST(req())).status).toBe(202);
    const seventh = await POST(req());
    expect(seventh.status).toBe(429);
    expect(mocks.afterCallbacks).toHaveLength(6);
  });

  it("swallows a rejecting warm instead of surfacing it anywhere", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.warmEatsFacets.mockRejectedValue(new Error("down"));
    await POST(req());
    await expect(mocks.afterCallbacks[0]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
