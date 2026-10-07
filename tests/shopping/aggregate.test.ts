import { describe, expect, it } from "vitest";
import { aggregateShopping, type RecipeUse } from "@/lib/shopping/aggregate";
import { ingredient, recipe } from "../recipes/fixture";
import { identity, identityFor, period } from "./fixture";

const used = (localDate: string, slotId: string, batchId: string | null): RecipeUse => ({
  recipe: recipe(), localDate, slotId, batchId, servingsConsumed: 1,
});

describe("shopping aggregation", () => {
  it("buys a cooked batch once for two leftover meals and subtracts shared stock once", () => {
    const shopping = aggregateShopping(period(), [used("2026-10-01", "dinner", "batch-1"),
      used("2026-10-02", "lunch", "batch-1")], {
      identityFor, pantry: [{ id: "stock", userId: "account-a", name: "beans",
        identity: identity("beans"), confirmedGrams: 40,
        confirmedAt: "2026-09-30", revision: 1 }],
      packages: [{ identity: identity("beans"), grams: 50 }],
    });
    const beans = shopping.lines.find((line) => line.name === "beans");
    expect(beans).toMatchObject({ needGrams: 100, confirmedStockGrams: 40, buyGrams: 100 });
    expect(beans?.sources).toHaveLength(2);
    expect(shopping.lines.find((line) => line.name === "salt")?.needGrams).toBe(100);
  });

  it("aggregates compatible refs but separates incompatible variants", () => {
    const bread = recipe({ recipeId: "bread", revisionId: "bread-v1", ingredients: [
      ingredient({ seq: 1, name: "bread A", foodRefId: "bread-a", purchaseGrams: 50 }),
      ingredient({ seq: 2, name: "bread B", foodRefId: "bread-b", purchaseGrams: 50 }),
      ingredient({ seq: 3, name: "gluten free bread", foodRefId: "bread-gf", purchaseGrams: 50 }),
    ] });
    const shopping = aggregateShopping(period(), [{ recipe: bread, localDate: "2026-10-01",
      slotId: "dinner", batchId: "b", servingsConsumed: 2 }], {
      identityFor: (line) => line.foodRefId === "bread-gf" ? identity("bread", "gluten-free")
        : identity("bread"),
    });
    expect(shopping.lines).toHaveLength(2);
    expect(shopping.lines.map((line) => line.needGrams).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([50, 100]);
  });

  it("preserves manual and notes, reopens checked lines after increased need", () => {
    const initial = aggregateShopping(period(), [used("2026-10-01", "dinner", "b")], { identityFor });
    const beans = initial.lines.find((line) => line.name === "beans")!;
    const manual = { ...beans, id: "manual-1", origin: "manual" as const,
      category: "manual" as const, sources: [], name: "birthday candles", checked: true };
    const next = aggregateShopping(period(), [used("2026-10-01", "dinner", "b"),
      used("2026-10-03", "dinner", "another")], {
      identityFor, existingLines: [{ ...beans, checked: true, note: "aisle 2" }, manual],
    });
    expect(next.lines.find((line) => line.name === "beans")).toMatchObject({
      needGrams: 100, checked: false, note: "aisle 2",
    });
    expect(next.lines.find((line) => line.name === "birthday candles")?.checked).toBe(true);
    expect(next.diff.find((row) => row.lineId === beans.id)?.additionalNeedGrams).toBe(50);
  });

  it("preserves the persisted UUID of a compatible derived line", () => {
    const initial = aggregateShopping(period(), [used("2026-10-01", "dinner", "b")], { identityFor });
    const beans = initial.lines.find((line) => line.name === "beans")!;
    const persisted = { ...beans, id: "e657a54d-40e1-4475-a010-5f7f9ddab467", checked: true };
    const next = aggregateShopping(period(), [used("2026-10-01", "dinner", "b")], {
      identityFor, existingLines: [persisted],
    });
    expect(next.lines.find((line) => line.name === "beans")?.id).toBe(persisted.id);
    expect(next.lines.find((line) => line.name === "beans")?.checked).toBe(true);
  });

  it("does not call incomplete price coverage budget-met or invent cooked-to-raw mass", () => {
    const stew = recipe({ ingredients: [ingredient({ seq: 1, name: "cooked rice",
      state: "cooked", purchaseGrams: null, purchaseConversionStatus: "unknown" })] });
    const shopping = aggregateShopping(period({ budgetAmount: 20 }), [{ recipe: stew,
      localDate: "2026-10-01", slotId: "dinner", batchId: null, servingsConsumed: 1 }], { identityFor });
    expect(shopping.lines[0].needGrams).toBeNull();
    expect(shopping.price.budgetMet).toBeNull();
    expect(shopping.issues).toContainEqual(expect.stringMatching(/Raw purchase/));
  });

  it("counts only this account's confirmed stock and sourced package price", () => {
    const full = aggregateShopping(period({ budgetAmount: 20 }), [used("2026-10-01", "dinner", "b")], {
      identityFor,
      pantry: [{ id: "other", userId: "account-b", name: "beans", identity: identity("beans"),
        confirmedGrams: 999, confirmedAt: "2026-09-30", revision: 1 }],
      prices: [{ identity: identity("beans"), packageGrams: 100, amount: 5,
        currency: "USD", locale: "US-CO", source: "store", observedAt: "2026-09-30" },
      { identity: identity("salt"), packageGrams: 100, amount: 2,
        currency: "USD", locale: "US-CO", source: "store", observedAt: "2026-09-30" }],
    });
    expect(full.lines.find((line) => line.name === "beans")?.confirmedStockGrams).toBe(0);
    expect(full.price).toMatchObject({ estimatedCheckoutAmount: 7, budgetMet: true,
      pricedLines: 2, requiredLines: 2 });
  });
});
