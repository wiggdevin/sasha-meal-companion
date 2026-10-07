import { describe, expect, it } from "vitest";
import { eligibleLocalFoodIds, eligibleLocalMarks } from "./eligible-client";
import type { Food } from "@/lib/foods";

const food = (id: string, status: Food["status"] = "eats"): Food => ({
  id, name: id, role: "protein", unit: "oz", perUnit: { protein: 10, carbs: 0, fat: 1 },
  status, updatedAt: "2026-09-27",
});

describe("local rule marks for Eats the server did not clear", () => {
  it("maps each excluded ref onto its local food; a blocked ref wins over an unknown one", () => {
    const foods = { pb: food("pb"), oat: food("oat"), safe: food("safe"), gone: food("gone", "avoid") };
    const refs = Object.fromEntries(Object.keys(foods).map((id) =>
      [id, { userRefId: `u-${id}`, catalogRefId: id === "pb" ? "c-pb" : undefined,
        syncedAt: "2026-10-05", status: "eats" as const, note: null }]));
    const marks = eligibleLocalMarks(foods, refs, [
      { refId: "c-pb", verdict: "unknown", reason: "cannot be checked for peanut." },
      { refId: "u-pb", verdict: "blocked", reason: "has peanut, which your rules exclude." },
      { refId: "u-oat", verdict: "unknown", reason: "cannot be checked for gluten." },
      { refId: "u-gone", verdict: "blocked", reason: "is on your Avoid list." },
    ], new Set(["safe"]));
    expect(Object.fromEntries(marks)).toEqual({
      pb: { verdict: "blocked", reason: "has peanut, which your rules exclude." },
      oat: { verdict: "unknown", reason: "cannot be checked for gluten." },
    });
  });
});

describe("local food eligibility projection", () => {
  it("allows only account-verified IDs and every mapped ref", () => {
    const foods = { safe: food("safe"), mixed: food("mixed"), unseen: food("unseen"),
      avoided: food("avoided", "avoid") };
    const refs = Object.fromEntries(Object.keys(foods).map((id) =>
      [id, { userRefId: `u-${id}`, catalogRefId: id === "mixed" ? "c-mixed" : undefined,
        syncedAt: "2026-09-27", status: "eats" as const, note: null }]));
    const result = eligibleLocalFoodIds(foods, refs, {
      eligibleRefIds: ["u-safe", "u-mixed", "u-avoided"], eligibleFoodIds: [],
      eligibleCatalogFoodIds: [],
    });
    expect([...result]).toEqual(["safe"]);
  });

  it("keeps an unsynced starter out even when its name resembles an eligible food", () => {
    const starter = { ...food("starter:tofu-firm"), name: "Tofu" };
    expect(eligibleLocalFoodIds({ [starter.id]: starter }, {}, {
      eligibleRefIds: [], eligibleFoodIds: [], eligibleCatalogFoodIds: [],
    }).size).toBe(0);
  });

  it("admits a starter after its account-owned ref is verified", () => {
    const starter = food("starter:tofu-firm");
    expect([...eligibleLocalFoodIds({ [starter.id]: starter }, {
      [starter.id]: { userRefId: "own-ref", syncedAt: "2026-09-27",
        status: "eats", note: null },
    }, { eligibleRefIds: ["own-ref"], eligibleFoodIds: [], eligibleCatalogFoodIds: [] })])
      .toEqual([starter.id]);
  });

  it("withholds a catalog-linked row without refs even when its user ID is allowed", () => {
    const linked = { ...food("food-own"), catalogFoodId: 42 };
    expect(eligibleLocalFoodIds({ [linked.id]: linked }, {}, {
      eligibleRefIds: [], eligibleFoodIds: [linked.id], eligibleCatalogFoodIds: [42],
    }).size).toBe(0);
  });
});
