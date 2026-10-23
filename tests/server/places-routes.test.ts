/**
 * UI makeover W8 §7.4: the wire guard for POST /api/shopping/places/{geocode,stores} and
 * POST /api/shopping/build/rank. Auth (and the Shopping pilot) before the limiter and any upstream
 * call; per-account limits with fixed keys and numbers; strict, capped bodies; no-store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), limit: vi.fn(), geocode: vi.fn(), stores: vi.fn(), rank: vi.fn() }));
vi.mock("@/lib/server/recipe-access", () => ({ requireRecipeUser: mocks.auth }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/server/places", () => ({ geocodePlace: mocks.geocode, nearbyStores: mocks.stores }));
vi.mock("@/lib/server/shopping-build-rank", async (original) => ({
  ...(await original<typeof import("@/lib/server/shopping-build-rank")>()), rankShoppingCandidates: mocks.rank,
}));

const { POST: GEOCODE } = await import("@/app/api/shopping/places/geocode/route");
const { POST: STORES } = await import("@/app/api/shopping/places/stores/route");
const { POST: RANK } = await import("@/app/api/shopping/build/rank/route");

const userId = "00000000-0000-4000-8000-000000000001";
const req = (path: string, body: unknown) => new Request(`http://test/api/shopping/${path}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const GOOD_RANK = { candidates: [{ id: "a", name: "Eggs" }, { id: "b", name: "Spinach" }] };

const ROUTES = [
  { name: "geocode", call: (b: unknown) => GEOCODE(req("places/geocode", b)), good: { q: "94110", country: "US" },
    key: `places-geocode:${userId}`, limit: [10, 600], work: mocks.geocode },
  { name: "stores", call: (b: unknown) => STORES(req("places/stores", b)), good: { lat: 37.76, lon: -122.41 },
    key: `places-stores:${userId}`, limit: [20, 600], work: mocks.stores },
  { name: "rank", call: (b: unknown) => RANK(req("build/rank", b)), good: GOOD_RANK,
    key: `shopping-build-rank:${userId}`, limit: [10, 60], work: mocks.rank },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId, client: { fake: true } });
  mocks.limit.mockResolvedValue(undefined);
  mocks.geocode.mockResolvedValue({ lat: 37.76, lon: -122.41, label: "Mission District, San Francisco" });
  mocks.stores.mockResolvedValue([{ id: "node/1", name: "Rainbow Grocery", lat: 37.7695, lon: -122.4155, distanceM: 1050 }]);
  mocks.rank.mockResolvedValue({ order: ["b", "a"], provenance: { ai: true, source: "jev", purpose: "shopping-build-rank" } });
});

describe.each(ROUTES)("POST $name", (route) => {
  it("answers 401 signed out, before the limiter or any upstream call", async () => {
    mocks.auth.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    expect((await route.call(route.good)).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(route.work).not.toHaveBeenCalled();
  });

  it("answers 404 outside the Shopping pilot, before the limiter or any upstream call", async () => {
    mocks.auth.mockRejectedValue(new HttpError(404, "recipe_pilot_unavailable", "Not available."));
    const res = await route.call(route.good);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("recipe_pilot_unavailable");
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(route.work).not.toHaveBeenCalled();
  });

  it("limits per account with its own key and numbers, fail closed (no policy argument)", async () => {
    const res = await route.call(route.good);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.limit).toHaveBeenCalledTimes(1);
    expect(mocks.limit).toHaveBeenCalledWith(route.key, ...route.limit);
  });

  it("passes the limiter's refusal through and does no work", async () => {
    mocks.limit.mockRejectedValue(new HttpError(429, "rate_limited", "Slow down."));
    expect((await route.call(route.good)).status).toBe(429);
    mocks.limit.mockRejectedValue(new HttpError(503, "rate_limit_unavailable", "Busy."));
    expect((await route.call(route.good)).status).toBe(503);
    expect(route.work).not.toHaveBeenCalled();
  });

  it("refuses a smuggled field, a body that is not JSON and an oversized body", async () => {
    expect((await route.call({ ...route.good, budget: 80 })).status).toBe(400);
    expect((await route.call("not json")).status).toBe(400);
    expect([400, 413]).toContain((await route.call({ ...route.good, pad: "x".repeat(20_000) })).status);
    expect(route.work).not.toHaveBeenCalled();
  });
});

describe("POST /api/shopping/places/geocode", () => {
  it("answers the rounded point and label", async () => {
    const res = await GEOCODE(req("places/geocode", { q: " Mission District ", country: "US" }));
    expect(await res.json()).toEqual({ lat: 37.76, lon: -122.41, label: "Mission District, San Francisco" });
    expect(mocks.geocode).toHaveBeenCalledWith("Mission District", "US");
  });

  it("needs a country and 1–120 characters of area", async () => {
    for (const body of [{ q: "94110" }, { q: "94110", country: "" }, { q: "94110", country: "USA" },
      { q: "", country: "US" }, { q: "   ", country: "US" }, { q: "x".repeat(121), country: "US" },
      { q: 94110, country: "US" }]) {
      expect((await GEOCODE(req("places/geocode", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.geocode).not.toHaveBeenCalled();
  });

  it("answers an upstream 503 as places_unavailable", async () => {
    mocks.geocode.mockRejectedValue(new HttpError(503, "places_unavailable",
      "Store search isn't available right now. You can skip this step."));
    const res = await GEOCODE(req("places/geocode", { q: "94110", country: "US" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "places_unavailable",
      message: "Store search isn't available right now. You can skip this step." });
  });
});

describe("POST /api/shopping/places/stores", () => {
  it("answers { stores }", async () => {
    const res = await STORES(req("places/stores", { lat: 37.76, lon: -122.41 }));
    expect(await res.json()).toEqual({ stores: [
      { id: "node/1", name: "Rainbow Grocery", lat: 37.7695, lon: -122.4155, distanceM: 1050 }] });
    expect(mocks.stores).toHaveBeenCalledWith(37.76, -122.41);
  });

  it("refuses a point off the globe or not a number", async () => {
    for (const body of [{ lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: "37.76", lon: -122.41 }, { lat: 37.76 }]) {
      expect((await STORES(req("places/stores", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.stores).not.toHaveBeenCalled();
  });
});

describe("POST /api/shopping/build/rank", () => {
  it("answers { order, provenance }", async () => {
    const res = await RANK(req("build/rank", GOOD_RANK));
    expect(await res.json()).toEqual({ order: ["b", "a"],
      provenance: { ai: true, source: "jev", purpose: "shopping-build-rank" } });
    expect(mocks.rank).toHaveBeenCalledWith(GOOD_RANK, userId);
  });

  it("needs 1–30 candidates with distinct, bounded ids and names", async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ id: `c${i}`, name: `Food ${i}` }));
    for (const body of [{ candidates: [] }, { candidates: many },
      { candidates: [{ id: "a", name: "Eggs" }, { id: "a", name: "Milk" }] },
      { candidates: [{ id: "", name: "Eggs" }] }, { candidates: [{ id: "a", name: "" }] },
      { candidates: [{ id: "x".repeat(121), name: "Eggs" }] }, { candidates: [{ id: "a", name: "x".repeat(161) }] },
      { candidates: [{ id: "a", name: "Eggs", source: "favorite" }] }]) {
      expect((await RANK(req("build/rank", body))).status).toBe(400);
    }
    expect(mocks.rank).not.toHaveBeenCalled();
  });
});
