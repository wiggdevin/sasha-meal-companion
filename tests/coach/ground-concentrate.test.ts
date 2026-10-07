import { describe, expect, it, vi } from "vitest";
import { groundActions } from "@/lib/coach/actions";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const REF = "3f1b1a2c-0000-4000-8000-000000000031";

/** Measured 2026-09-22: "protein shake" 300 g matched a shake POWDER (392 kcal/100 g, 10 g portion)
 *  and set a 1176 kcal meal. A concentrate at many times its own portion is a question, not a plan. */
describe("grounding a concentrate", () => {
  const powder = {
    foodRefId: REF, name: "Beverages, nutritional shake mix, high protein, powder", brand: null,
    catalogFoodRevisionId: 7139, kcalPer100g: 392, proteinPer100g: 53.57, carbsPer100g: 20.38,
    fatPer100g: 10.71, prefStatus: null, portionGrams: 10, portionLabel: "1 tbsp",
  };

  it("asks how much when a powder is given many times its portion", async () => {
    const result = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-09-22", slot: "meal-1", title: "Protein shake",
      items: [{ name: "Protein shake", grams: 300 }],
    }], TEST_PROFILE, { searchFoods: vi.fn(async () => [powder]), newActionId: () => "a" });

    expect(result.actions).toEqual([]);
    expect(result.clarifications).toEqual([
      "300 g of Beverages, nutritional shake mix, high protein, powder is 30 portions of 1 tbsp (10 g) — how much of it, or which ingredients make the shake?",
    ]);
  });

  it("still applies a powder at a plausible amount", async () => {
    const result = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-09-22", slot: "meal-1", title: "Protein shake",
      items: [{ name: "protein powder", grams: 30 }],
    }], TEST_PROFILE, { searchFoods: vi.fn(async () => [powder]), newActionId: () => "a" });

    expect(result.clarifications).toEqual([]);
    expect(result.actions[0]).toMatchObject({ kind: "set_slot_meal", items: [{ grams: 30 }] });
  });

  it("leaves a whole food alone at many times a small portion", async () => {
    const rice = { ...powder, name: "Rice, white, cooked", kcalPer100g: 130, portionGrams: 12,
      portionLabel: "1 tbsp" };
    const result = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-09-22", slot: "meal-2", title: "Rice",
      items: [{ name: "rice", grams: 160 }],
    }], TEST_PROFILE, { searchFoods: vi.fn(async () => [rice]), newActionId: () => "a" });

    expect(result.clarifications).toEqual([]);
    expect(result.actions).toHaveLength(1);
  });

  /** Production (2026-09-24): a catalog row's portionLabel carried a trailing junk id — "62 g of
   *  Nutritional powder mix (EAS Whey Protein Powder) is 6 portions of 1 tablespoon 21000 (10 g)".
   *  The question must read the portion label, never the raw catalog field. */
  it("drops trailing junk digits from a corrupted portion label", async () => {
    const corrupted = { ...powder, name: "Nutritional powder mix (EAS Whey Protein Powder)",
      portionLabel: "1 tablespoon 21000" };
    const result = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-09-22", slot: "meal-1", title: "Protein shake",
      items: [{ name: "Protein shake", grams: 62 }],
    }], TEST_PROFILE, { searchFoods: vi.fn(async () => [corrupted]), newActionId: () => "a" });

    expect(result.actions).toEqual([]);
    expect(result.clarifications).toEqual([
      "62 g of Nutritional powder mix (EAS Whey Protein Powder) is 6 portions of 1 tablespoon (10 g) — how much of it, or which ingredients make the shake?",
    ]);
  });

  it("falls back to grams-only phrasing when a corrupted label has nothing else usable", async () => {
    const corrupted = { ...powder, portionLabel: "90210" };
    const result = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-09-22", slot: "meal-1", title: "Protein shake",
      items: [{ name: "Protein shake", grams: 300 }],
    }], TEST_PROFILE, { searchFoods: vi.fn(async () => [corrupted]), newActionId: () => "a" });

    expect(result.clarifications).toEqual([
      "300 g of Beverages, nutritional shake mix, high protein, powder is 30 portions of 10 g — how much of it, or which ingredients make the shake?",
    ]);
  });
});
