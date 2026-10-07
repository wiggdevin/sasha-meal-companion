/**
 * Loop 010, 2026-09-14. AGENTS.md: "Nothing is deleted; 'avoid' keeps the note ('hurt on 9/12') so
 * she can bring it back." F-021's acceptance says the same: "Reactivating a previously-avoided food
 * restores its original note."
 *
 * FoodSheet's own "Bring it back" honours that — it goes through setFoodStatus, which touches only
 * the status. But AddFoodSheet lists an avoided food again as a candidate, and its row handed the
 * SEED definition to onAdd. A seed definition has no note, so re-adding the food that way replaced
 * her record and the note was gone: the reason she avoided the food in the first place, deleted by
 * the act of bringing it back.
 */
import { describe, expect, it } from "vitest";
import { reAddedFood } from "@/components/AddFoodSheet";
import type { Food } from "@/lib/foods";

const seed: Food = {
  id: "chicken-breast", name: "Chicken breast, cooked", role: "protein", unit: "oz",
  perUnit: { protein: 8, carbs: 0, fat: 1 }, status: "eats", updatedAt: "2026-01-01T00:00:00.000Z",
};
const NOW = "2026-09-14T18:00:00.000Z";

describe("reAddedFood", () => {
  it("keeps the note when bringing back a food she had avoided", () => {
    const prior: Food = { ...seed, status: "avoid", note: "hurt on 9/12" };
    const next = reAddedFood(prior, seed, NOW);
    expect(next.note).toBe("hurt on 9/12");
    expect(next.status).toBe("eats");
    expect(next.updatedAt).toBe(NOW);
  });

  it("keeps her edited values, not the seed's, for a food she already had", () => {
    const prior: Food = {
      ...seed, status: "avoid", note: "hurt on 9/12",
      perUnit: { protein: 9, carbs: 1, fat: 2 }, unit: "g",
    };
    const next = reAddedFood(prior, seed, NOW);
    expect(next.perUnit).toEqual({ protein: 9, carbs: 1, fat: 2 });
    expect(next.unit).toBe("g");
  });

  it("uses the seed definition for a food she has never had", () => {
    const next = reAddedFood(undefined, seed, NOW);
    expect(next).toEqual({ ...seed, status: "eats", updatedAt: NOW });
    expect(next.note).toBeUndefined();
  });

  it("does not resurrect a note she had cleared", () => {
    const prior: Food = { ...seed, status: "avoid", note: "" };
    expect(reAddedFood(prior, seed, NOW).note).toBe("");
  });
});
