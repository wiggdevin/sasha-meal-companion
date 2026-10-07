import { describe, expect, it, vi } from "vitest";
import { fetchOffProduct, isProviderFailure, OFF_FIELDS, OFF_USER_AGENT } from "@/lib/catalog/off";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PRODUCT = { product_name: "Dark chocolate bar", brands: "Kind", nutriments: { "energy-kcal_100g": 560 } };

describe("fetchOffProduct", () => {
  it("asks world.openfoodfacts.org for exactly the reviewed field list", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 1, product: PRODUCT }));
    const got = await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch });
    expect(got).toEqual(PRODUCT);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://world.openfoodfacts.org/api/v2/product/4006381333931.json?fields=${OFF_FIELDS.join(",")}`
    );
    expect(OFF_FIELDS).toEqual([
      "nutriments", "serving_quantity", "serving_size", "product_name", "brands",
      "quantity", "ingredients_text", "allergens_tags", "traces_tags", "categories_tags",
    ]);
    expect(OFF_FIELDS).not.toContain("image_front_url");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(OFF_USER_AGENT);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats OFF's status:0 body as a 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 0 }));
    expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
      .toEqual({ status: 404 });
  });

  it.each([[404], [429], [503]])("passes a %i through as a failure", async (status) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status }));
    expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
      .toEqual({ status });
  });

  it("reports a thrown fetch (timeout, abort, DNS, refused redirect) as a timeout", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("aborted"));
    expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
      .toEqual({ status: "timeout" });
  });

  it("reports an unparseable body as 502 rather than throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
      .toEqual({ status: 502 });
  });

  it("isProviderFailure separates the two arms", () => {
    expect(isProviderFailure({ status: 404 })).toBe(true);
    expect(isProviderFailure(PRODUCT)).toBe(false);
  });
});
