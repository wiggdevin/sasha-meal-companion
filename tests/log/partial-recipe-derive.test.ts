/**
 * #21: a card pulled from the server is marked partial from data already on the phone — the
 * recipe rows' loggable twin ref and stored coverage — with no new column.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({}) }));

const { partialRecipeRefIds } = await import("@/lib/recipes-client");
const { rowNutritionPartial } = await import("@/lib/log/partial-mark");
const { dayHasPartialNutrition } = await import("@/lib/resolve");

const rows: Parameters<typeof partialRecipeRefIds>[0] = [
  { id: "r1", food_ref_id: "ref-partial", nutrients_per_serving: { energy_kcal: 50, coverage: 0.5 } },
  { id: "r2", food_ref_id: "ref-whole", nutrients_per_serving: { energy_kcal: 200, coverage: 1 } },
  { id: "r3", nutrients_per_serving: { coverage: 0.2 } },
  { id: "r4", food_ref_id: "ref-gone", deleted_at: "2026-10-01T00:00:00Z",
    nutrients_per_serving: { coverage: 0.2 } },
];

describe("deriving the partial mark on the phone", () => {
  it("collects the twin refs of partly measured recipes, deleted ones included", () => {
    expect(partialRecipeRefIds(rows)).toEqual(new Set(["ref-partial", "ref-gone"]));
  });

  it("marks a server row whose items name a partial recipe; null when recipes were unreadable", () => {
    const refs = partialRecipeRefIds(rows);
    expect(rowNutritionPartial({ items: [{ food_ref_id: "ref-whole" }, { food_ref_id: "ref-partial" }] }, refs))
      .toBe(true);
    expect(rowNutritionPartial({ items: [{ food_ref_id: "ref-whole" }] }, refs)).toBe(false);
    expect(rowNutritionPartial({ items: [{ food_ref_id: "ref-partial" }] }, null)).toBeNull();
  });

  it("says a day's totals include a partial count when any card is marked", () => {
    const day = (marks: (boolean | undefined)[]) =>
      ({ extras: marks.map((nutritionPartial, i) => ({ id: `e${i}`, nutritionPartial })) }) as never;
    expect(dayHasPartialNutrition(day([undefined, true]))).toBe(true);
    expect(dayHasPartialNutrition(day([undefined, undefined]))).toBe(false);
  });
});

describe("pulled rows read the recorded flag first (round 3, BLOCK 2)", () => {
  it("marks from the stored flag with no mirrored recipe at all", () => {
    expect(rowNutritionPartial({ items: [{ food_ref_id: "unknown-ref", nutrition_partial: true }] }, null))
      .toBe(true);
    expect(rowNutritionPartial({ items: [{ food_ref_id: "unknown-ref", nutrition_partial: true }] },
      new Set())).toBe(true);
  });

  it("clears when every item carries a recorded false, whatever the local recipes say", () => {
    expect(rowNutritionPartial({ items: [{ food_ref_id: "ref-partial", nutrition_partial: false }] },
      new Set(["ref-partial"]))).toBe(false);
    expect(rowNutritionPartial({ items: [{ food_ref_id: "ref-partial", nutrition_partial: false }] },
      null)).toBe(false);
  });

  it("falls back to the local recipes only for unrecorded items", () => {
    const row = { items: [{ food_ref_id: "ref-whole", nutrition_partial: false },
      { food_ref_id: "ref-partial", nutrition_partial: null }] };
    expect(rowNutritionPartial(row, new Set(["ref-partial"]))).toBe(true);
    expect(rowNutritionPartial(row, new Set())).toBe(false);
    expect(rowNutritionPartial(row, null)).toBeNull();
  });
});
