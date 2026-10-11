// W024 (audit F12: A048, A046, A018): the shopping preview survives a pantry photo row with no food
// ref, a prepared batch that started more than two days ago, and a package size whose exact multiple
// is not exact in floating point.
import { describe, expect, it } from "vitest";
import { aggregateShopping, identityKey } from "@/lib/shopping/aggregate";
import { planShoppingPeriod } from "@/lib/shopping/planner";
import type { IngredientIdentity, PantryItem } from "@/lib/shopping/types";
import { ingredient, recipe } from "../recipes/fixture";
import { identity, identityFor, period } from "./fixture";

const candidate = (partial: Parameters<typeof recipe>[0] = {}) => ({
  ...recipe(partial), eligibility: { status: "eligible" as const, reasons: [] },
});
/** The identity lib/server/pantry-photo.ts stores for an item the catalog search never resolved. */
const photoIdentity = (name: string): IngredientIdentity => ({ foodRefId: null, foodDbId: null,
  catalogFoodRevisionId: null, purchaseState: "as_purchased", variantKey: name });
const photoRow = (name: string, confirmedGrams: number | null): PantryItem => ({
  id: `photo-${name}`, userId: "account-a", name, identity: photoIdentity(name), confirmedGrams,
  confirmedAt: "2026-09-30T12:00:00Z", revision: 1, source: "photo" });

describe("a pantry photo row with no food ref (A048)", () => {
  it("has a stable key of its own that never equals a ref-backed key", () => {
    expect(() => identityKey(photoIdentity("carrots"))).not.toThrow();
    expect(identityKey(photoIdentity("carrots"))).toBe(identityKey(photoIdentity("carrots")));
    expect(identityKey(photoIdentity("carrots"))).not.toBe(identityKey(photoIdentity("rice")));
    expect(identityKey(photoIdentity("beans"))).not.toBe(identityKey(identity("beans")));
  });

  it.each([null, 0, 250])("plans a period with a photo row of %s g", (grams) => {
    const result = planShoppingPeriod({ period: period(), candidates: [candidate()],
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: 200 }],
      basket: [], pins: [], aggregate: { identityFor, pantry: [photoRow("beans", grams)] } });
    expect(result.choices).toHaveLength(1);
    // An ungrounded photo row is never matched to a ref-backed recipe ingredient as stock.
    expect(result.shopping.lines.find((line) => line.name === "beans")?.confirmedStockGrams).toBe(0);
  });

  it("aggregates a list with a photo row and a null/null plan line", () => {
    const stew = recipe();
    const line = { id: "c1d7cf9a-55a2-4f4b-9a49-f4d6a3fd8d55", periodId: "period-1", origin: "plan" as const,
      name: "carrots", identity: photoIdentity("carrots"), category: "core" as const, needGrams: 100,
      confirmedStockGrams: 0, buyGrams: 100, packageGrams: null, purchaseConversionStatus: "known" as const,
      sources: [], pinned: false, checked: false, note: null, revision: 1 };
    expect(() => aggregateShopping(period(), [{ recipe: stew, localDate: "2026-10-01",
      slotId: "meal-3", servingsConsumed: 1, batchId: null }],
    { identityFor, pantry: [photoRow("carrots", 300)], existingLines: [line] })).not.toThrow();
  });
});

describe("prepared batch reuse (A046)", () => {
  it("never joins a batch whose first day is more than two days back", () => {
    const big = candidate({ servings: 4 });
    const slots = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]
      .map((localDate) => ({ localDate, slotId: "meal-3", targetKcal: 100 }));
    const result = planShoppingPeriod({ period: period(), candidates: [big], slots,
      basket: [], pins: [], aggregate: { identityFor } });
    expect(result.choices).toHaveLength(4);
    const firstDay = new Map<string, string>();
    for (const choice of result.choices) {
      const first = firstDay.get(choice.batchId!) ?? choice.localDate;
      firstDay.set(choice.batchId!, first);
      const gap = (Date.parse(choice.localDate) - Date.parse(first)) / 86_400_000;
      expect(gap).toBeLessThanOrEqual(2);
      expect(choice.preparedOn).toBe(first);
    }
    expect(result.choices[3].batchId).not.toBe(result.choices[0].batchId);
  });
});

describe("package rounding (A018)", () => {
  it.each([[340.2, 7], [170.1, 7]])("buys exactly %s g × %s, not one extra package", (pack, count) => {
    const need = Math.round(pack * count * 10_000) / 10_000;
    const single = recipe({ servings: 1, ingredients: [ingredient({ seq: 1, name: "beans",
      purchaseGrams: need })] });
    const shopping = aggregateShopping(period({ budgetAmount: 1000 }), [{ recipe: single,
      localDate: "2026-10-01", slotId: "meal-3", servingsConsumed: 1, batchId: null }], {
      identityFor, packages: [{ identity: identity("beans"), grams: pack }],
      prices: [{ identity: identity("beans"), packageGrams: pack, amount: 2, currency: "USD",
        locale: "US-CO", source: "store", observedAt: "2026-09-30" }] });
    const line = shopping.lines.find((row) => row.name === "beans");
    expect(line?.needGrams).toBe(need);
    expect(line?.buyGrams).toBe(need);
    expect(shopping.price.estimatedCheckoutAmount).toBe(count * 2);
  });

  it("still rounds a real remainder up to the next package", () => {
    const single = recipe({ servings: 1, ingredients: [ingredient({ seq: 1, name: "beans",
      purchaseGrams: 2381.5 })] });
    const shopping = aggregateShopping(period(), [{ recipe: single, localDate: "2026-10-01",
      slotId: "meal-3", servingsConsumed: 1, batchId: null }], {
      identityFor, packages: [{ identity: identity("beans"), grams: 340.2 }] });
    expect(shopping.lines[0].buyGrams).toBe(2721.6);
  });

  it("gives the same package count in the weekly replenishment", () => {
    const single = candidate({ servings: 1, ingredients: [ingredient({ seq: 1, name: "beans",
      purchaseGrams: 2381.4 })] });
    const result = planShoppingPeriod({ period: period(), candidates: [single],
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: null }], basket: [], pins: [],
      aggregate: { identityFor, packages: [{ identity: identity("beans"), grams: 340.2 }] } });
    expect(result.replenishment[0].lines[0].buyGrams).toBe(2381.4);
  });
});
