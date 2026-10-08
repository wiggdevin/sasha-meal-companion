/**
 * Phase 18 W11 (docs/specs/phase-18-open-world-foods.md §W11), acceptance 4: an account without
 * shopping access gets a clear refusal and no write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), get: vi.fn(), set: vi.fn(), resolve: vi.fn(),
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/server/recipe-access", () => ({ requireRecipeUser: mocks.auth }));
vi.mock("@/lib/server/shopping-focus", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/shopping-focus")>(
    "@/lib/server/shopping-focus");
  return {
    getShoppingFocusUntil: mocks.get, setShoppingFocusUntil: mocks.set, resolveFocusEnd: mocks.resolve,
    // The real clamp: pure, and route.ts's own cap on a direct `exact` caller is worth exercising
    // for real here rather than stubbed through.
    clampExactFocusEnd: actual.clampExactFocusEnd,
  };
});

const { GET, POST } = await import("@/app/api/shopping/focus/route");

const userId = "00000000-0000-4000-8000-000000000001";
const req = (body?: unknown) => new Request("http://test/api/shopping/focus",
  body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId, client: { fake: true } });
});

describe("W11 acceptance 4: no shopping access", () => {
  it("GET refuses before reading anything", async () => {
    mocks.auth.mockRejectedValue(new HttpError(404, "recipe_pilot_unavailable", "Not available."));
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("POST refuses before writing anything", async () => {
    mocks.auth.mockRejectedValue(new HttpError(404, "recipe_pilot_unavailable", "Not available."));
    const res = await POST(req({ on: true }));
    expect(res.status).toBe(404);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

describe("POST /api/shopping/focus", () => {
  it("turns focus on, resolving the default end when no days are given", async () => {
    mocks.resolve.mockResolvedValue("2026-10-12T23:59:59.999Z");
    mocks.set.mockResolvedValue(null);
    const res = await POST(req({ on: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ until: "2026-10-12T23:59:59.999Z", previous: null });
    expect(mocks.resolve).toHaveBeenCalledWith({ fake: true }, userId, expect.any(Date), undefined);
    expect(mocks.set).toHaveBeenCalledWith({ fake: true }, userId, "2026-10-12T23:59:59.999Z");
  });

  it("turns focus off, writing null and never resolving an end date", async () => {
    mocks.set.mockResolvedValue("2026-10-05T00:00:00.000Z");
    const res = await POST(req({ on: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ until: null, previous: "2026-10-05T00:00:00.000Z" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith({ fake: true }, userId, null);
  });

  it("an exact value (Undo) bypasses resolveFocusEnd entirely", async () => {
    mocks.set.mockResolvedValue(null);
    const res = await POST(req({ on: true, exact: "2026-10-09T00:00:00.000Z" }));
    expect(res.status).toBe(200);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith({ fake: true }, userId, "2026-10-09T00:00:00.000Z");
  });

  it("an exact null (Undo clearing to off) writes null directly", async () => {
    mocks.set.mockResolvedValue("2026-10-05T00:00:00.000Z");
    const res = await POST(req({ on: false, exact: null }));
    expect(res.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith({ fake: true }, userId, null);
  });

  it("clamps a far-future `exact` at FOCUS_MAX_DAYS from now — a direct caller cannot use "
    + "Undo's own escape hatch to set a date beyond what resolveFocusEnd would ever produce", async () => {
    mocks.set.mockResolvedValue(null);
    const res = await POST(req({ on: true, exact: "2099-01-01T00:00:00.000Z" }));
    expect(res.status).toBe(200);
    const { until } = await res.json() as { until: string };
    expect(Date.parse(until)).toBeLessThan(Date.parse("2099-01-01T00:00:00.000Z"));
    expect(Date.parse(until) - Date.now()).toBeLessThanOrEqual(31 * 86_400_000 + 1_000);
    expect(mocks.set).toHaveBeenCalledWith({ fake: true }, userId, until);
  });

  it("rejects a malformed body before calling anything", async () => {
    const res = await POST(req({ on: "yes" }));
    expect(res.status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});

describe("GET /api/shopping/focus", () => {
  it("reports active for a future timestamp, inactive for null", async () => {
    mocks.get.mockResolvedValue("2099-01-01T00:00:00.000Z");
    const on = await GET(req());
    expect(await on.json()).toEqual({ until: "2099-01-01T00:00:00.000Z", active: true });

    mocks.get.mockResolvedValue(null);
    const off = await GET(req());
    expect(await off.json()).toEqual({ until: null, active: false });
  });
});
