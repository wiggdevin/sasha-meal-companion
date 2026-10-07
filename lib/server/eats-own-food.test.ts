import { describe, expect, it, vi } from "vitest";

const getFoodDetail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/catalog", () => ({ getFoodDetail }));
vi.mock("@/lib/server/day-context", () => ({
  foodNamesFor: async (_c: unknown, ids: string[]) => new Map(ids.map((id) => [id, id === "ref-c" ? "Banana, raw" : "Other"])),
}));
vi.mock("@/lib/server/coach", () => ({
  mapCatalogFoodHit: (hit: { description: string }, _d: unknown, refId: string) => ({ name: hit.description, foodRefId: refId }),
}));

import { eatsOwnFood } from "@/lib/server/eats-own-food";

function client() {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "range"]) chain[m] = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(table === "user_food_prefs"
      ? { data: [{ food_ref_id: "ref-c" }, { food_ref_id: "ref-x" }], error: null }
      : { data: [{ id: "ref-c", catalog_food_id: 7 }, { id: "ref-x", catalog_food_id: 9 }], error: null });
    return chain;
  });
  return { from } as never;
}

describe("eatsOwnFood", () => {
  it("returns the account's own food first, with no catalog read", async () => {
    const exact = vi.fn(async () => ({ name: "Eggs, large", foodRefId: "u1" }) as never);
    const find = eatsOwnFood(client(), exact);
    expect(await find("u", "Eggs, large")).toMatchObject({ foodRefId: "u1" });
    expect(getFoodDetail).not.toHaveBeenCalled();
  });

  it("resolves a catalog Eats food through its own ref and one detail read", async () => {
    getFoodDetail.mockResolvedValue({ description: "Banana, raw" });
    const find = eatsOwnFood(client(), async () => null);
    expect(await find("u", "banana,  raw")).toEqual({ name: "Banana, raw", foodRefId: "ref-c" });
    expect(getFoodDetail).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it("answers null for a name that is not on the Eats list, so the caller searches", async () => {
    const find = eatsOwnFood(client(), async () => null);
    expect(await find("u", "Seitan")).toBeNull();
  });
});

describe("eatsOwnFood per account", () => {
  it("keeps each account's Eats map apart and reads again after a failure", async () => {
    let calls = 0;
    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "range"]) chain[m] = vi.fn(() => chain);
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === "user_food_prefs") calls += 1;
        return resolve(table === "user_food_prefs" && calls === 1 ? { data: null, error: new Error("down") }
          : table === "user_food_prefs" ? { data: [{ food_ref_id: "ref-c" }], error: null }
          : { data: [{ id: "ref-c", catalog_food_id: 7 }], error: null });
      };
      return chain;
    });
    getFoodDetail.mockResolvedValue({ description: "Banana, raw" });
    const find = eatsOwnFood({ from } as never, async () => null);
    expect(await find("a", "Banana, raw")).toBeNull();
    expect(await find("a", "Banana, raw")).toEqual({ name: "Banana, raw", foodRefId: "ref-c" });
    expect(await find("b", "Banana, raw")).toEqual({ name: "Banana, raw", foodRefId: "ref-c" });
    expect(calls).toBe(3);
  });
});
