/**
 * An uploaded plan's amounts against catalog portions (lib/plan/document-ground.ts,
 * lib/plan/document-clean.ts): a weight-labelled portion is one portion, never a count of grams; a
 * measure binds to its own unit as a whole word; thousands separators are not decimals. The food
 * search is injected; no I/O.
 */
import { describe, expect, it, vi } from "vitest";
import type { FoodHit } from "@/lib/coach/executors";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { labelHasMeasure, parseAmount } from "@/lib/plan/document-clean";
import { groundDocumentMeal } from "@/lib/plan/document-ground";

const hit = (name: string, portionGrams: number, portionLabel: string): FoodHit => ({
  foodRefId: `${name}-ref`, name, brand: null, prefStatus: "eats", kcalPer100g: 100, proteinPer100g: 10,
  carbsPer100g: 10, fatPer100g: 2, catalogFoodRevisionId: 1, allergenTags: [], category: [],
  portionGrams, portionLabel,
});

/** Grams placed for one food whose search returns these hits in order. */
async function grams(amount: string | null, ...hits: FoodHit[]): Promise<number | string> {
  const searchFoods = vi.fn(async () => hits);
  const { items, left } = await groundDocumentMeal("u", { name: "Lunch", time: null,
    foods: [{ name: "food", amount }] }, EMPTY_PROFILE, { searchFoods });
  return items[0]?.grams ?? left[0].reason;
}

describe("household portions against weight labels", () => {
  it("treats a portion labelled in a weight as one portion", async () => {
    expect(await grams(null, hit("yogurt", 100, "100 g"))).toBe(100);
    expect(await grams("2", hit("yogurt", 100, "100 g"))).toBe(200);
    expect(await grams("2", hit("cheese", 28, "1 oz"))).toBe(56);
    expect(await grams("2", hit("cheese", 28, "1oz"))).toBe(56);
    expect(await grams("1", hit("milk", 258, "250 ml"))).toBe(258);
  });

  it("still divides by a household count or a matching measure", async () => {
    expect(await grams("2", hit("bread", 50, "2 slices"))).toBe(50);
    expect(await grams("1 cup", hit("oats", 40, "1/2 cup"))).toBe(80);
    expect(await grams("500 ml", hit("milk", 103, "100 ml"))).toBe(515);
    expect(await grams("2 eggs", hit("egg", 50, "1 large"))).toBe(100);
  });
});

describe("bounded unit words", () => {
  it("binds litres only to a litre label, never to large, lb, leaf, loaf or link", async () => {
    for (const label of ["1 large", "1 lb", "1 leaf", "1 loaf", "1 link", "1 leg"]) {
      expect(labelHasMeasure(label, "l"), label).toBe(false);
    }
    expect(labelHasMeasure("1 l", "l")).toBe(true);
    expect(labelHasMeasure("1 litre", "l")).toBe(true);
    expect(labelHasMeasure("1l", "l")).toBe(true);
    expect(labelHasMeasure("1 cupcake", "cup")).toBe(false);
    expect(labelHasMeasure("2 cups", "cup")).toBe(true);
    expect(labelHasMeasure("1 tablespoon", "tbsp")).toBe(true);
    expect(await grams("2 l", hit("stock", 453, "1 lb"))).toBe("No gram weight for that amount");
    expect(await grams("1 l", hit("stock", 453, "1 lb"), hit("stock, liquid", 1010, "1 l"))).toBe(1010);
    expect(await grams("1 cup", hit("muffin", 60, "1 cupcake"))).toBe("No gram weight for that amount");
  });

  it("reads a whole unit word only", () => {
    expect(parseAmount("2 large")).toEqual({ count: 2 });
    expect(parseAmount("1 l")).toEqual({ measure: "l", count: 1 });
    expect(parseAmount("1 lb")).toEqual({ grams: 454 });
    expect(parseAmount("2 glasses")).toEqual({ count: 2 });
  });
});

describe("thousands separators", () => {
  it("reads 1,500 as fifteen hundred and 1,5 as one and a half", async () => {
    expect(parseAmount("1,500 g")).toEqual({ grams: 1500 });
    expect(parseAmount("1,500g")).toEqual({ grams: 1500 });
    expect(parseAmount("1,5 kg")).toEqual({ grams: 1500 });
    expect(parseAmount("1.5 kg")).toEqual({ grams: 1500 });
    expect(parseAmount("1,250 ml")).toEqual({ measure: "ml", count: 1250 });
    expect(await grams("1,500 g", hit("rice", 158, "1 cup"))).toBe(1500);
    expect(await grams("12,000 g", hit("rice", 158, "1 cup"))).toBe("The amount is out of range");
  });
});
