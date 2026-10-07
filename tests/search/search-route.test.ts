import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, requireUser } from "@/lib/server/auth";
import { NoActiveCatalogVersion, searchFoods } from "@/lib/server/catalog";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { GET } from "@/app/api/foods/search/route";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/catalog", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/catalog")>()),
  searchFoods: vi.fn(),
}));

const mockedUser = vi.mocked(requireUser);
const mockedSearch = vi.mocked(searchFoods);

const RESPONSE = { hits: [], queryClass: "generic" as const, autoResolve: null, catalogVersion: "v1" };

function req(query: string, ip = "1.1.1.1"): Request {
  return new Request(`https://app.test/api/foods/search${query}`, {
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  resetRateLimits();
  mockedUser.mockReset();
  mockedSearch.mockReset();
  mockedUser.mockResolvedValue({ userId: "user-a", client: {} as never });
  mockedSearch.mockResolvedValue(RESPONSE);
});

describe("GET /api/foods/search", () => {
  it("returns the search response for an authenticated caller", async () => {
    const res = await GET(req("?q=chicken"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESPONSE);
    expect(mockedSearch).toHaveBeenCalledWith({}, { q: "chicken", brand: undefined, prep: undefined, limit: 25 });
  });

  it("passes brand, prep and limit through", async () => {
    await GET(req("?q=oil&brand=Kirkland&prep=roasted&limit=5"));
    expect(mockedSearch).toHaveBeenCalledWith({}, { q: "oil", brand: "Kirkland", prep: "roasted", limit: 5 });
  });

  it("401s with no session, without touching the catalog", async () => {
    mockedUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    const res = await GET(req("?q=chicken"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", message: "Sign in to continue." });
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty q", "?q="],
    ["a missing q", ""],
    ["a q over 120 chars", `?q=${"a".repeat(121)}`],
    ["limit 0", "?q=rice&limit=0"],
    ["limit 26", "?q=rice&limit=26"],
    ["a prep outside the enum", "?q=rice&prep=sous-vide"],
  ])("400s on %s", async (_label, query) => {
    const res = await GET(req(query));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("413s on a URL over 8 KB", async () => {
    const res = await GET(req(`?q=rice&pad=${"x".repeat(8500)}`));
    expect(res.status).toBe(413);
  });

  it("429s past 120 requests a minute, with Retry-After", async () => {
    for (let i = 0; i < 120; i += 1) expect((await GET(req("?q=rice"))).status).toBe(200);
    const res = await GET(req("?q=rice"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("503s when no catalog version is active", async () => {
    mockedSearch.mockRejectedValue(new NoActiveCatalogVersion());
    const res = await GET(req("?q=chicken"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("catalog_unavailable");
  });

  it("never echoes a SQL message on a 500", async () => {
    mockedSearch.mockRejectedValue(new Error('relation "catalog_food_revisions" does not exist'));
    const res = await GET(req("?q=chicken"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });
});
