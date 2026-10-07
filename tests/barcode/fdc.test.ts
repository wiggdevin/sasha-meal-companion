import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFdcBranded } from "@/lib/catalog/fdc";

const FOOD = {
  fdcId: 123456, description: "DARK CHOCOLATE NUTS & SEA SALT", brandName: "KIND",
  gtinUpc: "0602652171000", foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 560 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => { delete process.env.FDC_API_KEY; vi.restoreAllMocks(); });

describe("fetchFdcBranded", () => {
  it("searches Branded by the provider code and sends the key as a header", async () => {
    process.env.FDC_API_KEY = "test-key";
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ foods: [FOOD] }));
    const got = await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch });
    expect(got).toEqual(FOOD);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.nal.usda.gov/fdc/v1/foods/search?query=0602652171000&dataType=Branded&pageSize=5"
    );
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(url).not.toContain("api_key");
    expect(init.redirect).toBe("error");
  });

  it("keeps only a food whose gtinUpc normalises to the same GTIN-14", async () => {
    process.env.FDC_API_KEY = "test-key";
    const other = { ...FOOD, fdcId: 9, gtinUpc: "4006381333931" };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ foods: [other, FOOD] }));
    expect(await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch }))
      .toEqual(FOOD);
  });

  it("is a 404 when no returned food carries that GTIN", async () => {
    process.env.FDC_API_KEY = "test-key";
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ foods: [] }));
    expect(await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch }))
      .toEqual({ status: 404 });
  });

  it("is a 401 with no FDC_API_KEY, and never calls out", async () => {
    const fetchFn = vi.fn();
    expect(await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch }))
      .toEqual({ status: 401 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a throw to a timeout and a non-200 to its status", async () => {
    process.env.FDC_API_KEY = "test-key";
    const thrower = vi.fn().mockRejectedValue(new Error("aborted"));
    expect(await fetchFdcBranded("00602652171000", { fetchFn: thrower as unknown as typeof fetch }))
      .toEqual({ status: "timeout" });
    const failing = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    expect(await fetchFdcBranded("00602652171000", { fetchFn: failing as unknown as typeof fetch }))
      .toEqual({ status: 429 });
  });
});
