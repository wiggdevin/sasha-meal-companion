import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, requireUser } from "@/lib/server/auth";
import { getFoodDetail, NoActiveCatalogVersion } from "@/lib/server/catalog";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { GET } from "@/app/api/foods/[id]/route";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/catalog", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/catalog")>()),
  getFoodDetail: vi.fn(),
}));

const mockedUser = vi.mocked(requireUser);
const mockedDetail = vi.mocked(getFoodDetail);

const DETAIL = {
  catalogFoodId: 7, revisionId: 70, description: "Chicken, breast, roasted", brand: null,
  source: "fdc_sr_legacy" as const, qualityClass: "analytical" as const, qualityFlags: [],
  prepState: "roasted" as const, score: 0, prefStatus: null, policy: { verdict: "unverified" as const },
  category: "Poultry Products",
  catalogVersion: "fdc-2026-09", attribution: "USDA FoodData Central — SR Legacy (fdc-2026-09)",
  per100g: {}, portions: [], ingredients: [], policyCategories: [],
  ingredientsText: null, ingredientsTextIsLabel: true, nameOnlyAllergenHints: [],
  kcalPer100g: null, simplePer100g: null,
  servingPortions: [{ id: null, label: "100 g", grams: 100, kcal: null }], defaultPortion: null,
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string) =>
  new Request(`https://app.test/api/foods/${id}`, { headers: { "x-forwarded-for": "2.2.2.2" } });

beforeEach(() => {
  resetRateLimits();
  mockedUser.mockReset();
  mockedDetail.mockReset();
  mockedUser.mockResolvedValue({ userId: "user-a", client: {} as never });
  mockedDetail.mockResolvedValue(DETAIL);
});

describe("GET /api/foods/[id]", () => {
  it("returns the detail for an authenticated caller", async () => {
    const res = await GET(req("7"), ctx("7"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DETAIL);
    expect(mockedDetail).toHaveBeenCalledWith({}, 7);
  });

  it("401s with no session", async () => {
    mockedUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    expect((await GET(req("7"), ctx("7"))).status).toBe(401);
    expect(mockedDetail).not.toHaveBeenCalled();
  });

  it.each([["a non-numeric id", "chicken"], ["a negative id", "-3"], ["a fractional id", "1.5"]])(
    "400s on %s",
    async (_label, id) => {
      const res = await GET(req(id), ctx(id));
      expect(res.status).toBe(400);
      expect(mockedDetail).not.toHaveBeenCalled();
    }
  );

  it("404s on an unknown or inactive food", async () => {
    mockedDetail.mockRejectedValue(new HttpError(404, "not_found", "No active revision for that food."));
    expect((await GET(req("9"), ctx("9"))).status).toBe(404);
  });

  it("503s when no catalog version is active", async () => {
    mockedDetail.mockRejectedValue(new NoActiveCatalogVersion());
    const res = await GET(req("7"), ctx("7"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("catalog_unavailable");
  });

  it("429s past 120 requests a minute, with Retry-After", async () => {
    for (let i = 0; i < 120; i += 1) expect((await GET(req("7"), ctx("7"))).status).toBe(200);
    const res = await GET(req("7"), ctx("7"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});
