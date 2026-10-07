import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  afterCallbacks: [] as (() => unknown)[],
  applyLogEntry: vi.fn(),
  ensureCatalogRevisionFacets: vi.fn(),
  ensureUserFoodFacets: vi.fn(),
  requireUser: vi.fn(),
  resolveBarcode: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/foods/facet-warm", () => ({
  ensureCatalogRevisionFacets: mocks.ensureCatalogRevisionFacets,
  ensureUserFoodFacets: mocks.ensureUserFoodFacets,
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ service: true }) }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: mocks.requireUser,
}));
vi.mock("@/lib/server/barcode", () => ({
  refreshBarcode: vi.fn(), resolveBarcode: mocks.resolveBarcode,
}));
vi.mock("@/lib/server/log", () => ({ applyLogEntry: mocks.applyLogEntry }));

const barcodeRoute = await import("@/app/api/foods/barcode/route");
const logRoute = await import("@/app/api/log/commit/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  process.env.NEXT_PUBLIC_FEATURE_SCAN = "1";
  mocks.requireUser.mockResolvedValue({ userId: "user-1", client: {} });
  mocks.afterCallbacks.length = 0;
  mocks.after.mockImplementation((callback) => { mocks.afterCallbacks.push(callback); });
  mocks.ensureCatalogRevisionFacets.mockResolvedValue({});
  mocks.ensureUserFoodFacets.mockResolvedValue({});
});

describe("facet creation hooks", () => {
  it("schedules barcode facets after the route has its response", async () => {
    mocks.resolveBarcode.mockResolvedValue({ status: "resolved", gtin14: "04006381333931",
      cached: false, match: { revisionId: 81, description: "Rice bowl", brand: "Kitchen",
        ingredientsText: "rice, water", portions: [{ description: "1 bowl", isDefault: true }] } });
    const response = await barcodeRoute.POST(new Request("https://app.test/api/foods/barcode", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gtin: "04006381333931" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.ensureCatalogRevisionFacets).not.toHaveBeenCalled();
    await mocks.afterCallbacks[0]();
    expect(mocks.ensureCatalogRevisionFacets).toHaveBeenCalledWith([81], { userId: "user-1" });
  });

  it("schedules newly created user-food facets after the commit response", async () => {
    mocks.applyLogEntry.mockResolvedValue({ status: "ok", entry_id: "entry-1", rev: 1,
      user_food_id: "food-1" });
    const response = await logRoute.POST(new Request("https://app.test/api/log/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label_food: {
        name: "Pear pouch", brand: "Serenity", ingredientsText: "pear",
      } }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.ensureUserFoodFacets).not.toHaveBeenCalled();
    await mocks.afterCallbacks[0]();
    expect(mocks.ensureUserFoodFacets).toHaveBeenCalledWith(["food-1"], { userId: "user-1" });
  });

  it("swallows a rejecting dynamic import in both after() hooks", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("@/lib/foods/facet-warm", () => { throw new Error("import failed"); });
    const [isolatedBarcode, isolatedLog] = await Promise.all([
      import("@/app/api/foods/barcode/route"), import("@/app/api/log/commit/route"),
    ]);
    mocks.resolveBarcode.mockResolvedValue({ status: "resolved", gtin14: "04006381333931",
      cached: false, match: { revisionId: 82, description: "Rice", brand: null,
        ingredientsText: "rice", portions: [] } });
    mocks.applyLogEntry.mockResolvedValue({ status: "ok", entry_id: "entry-2", rev: 1,
      user_food_id: "food-2" });

    await isolatedBarcode.POST(new Request("https://app.test/api/foods/barcode", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gtin: "04006381333931" }),
    }));
    await isolatedLog.POST(new Request("https://app.test/api/log/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label_food: { name: "Pear", ingredientsText: "pear" } }),
    }));

    await expect(mocks.afterCallbacks[0]()).resolves.toBeUndefined();
    await expect(mocks.afterCallbacks[1]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
