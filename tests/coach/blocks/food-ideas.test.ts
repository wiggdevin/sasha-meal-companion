import { describe, expect, it } from "vitest";
import { hydrateResolvedTool } from "@/lib/coach/blocks";
import { hydrateFoodIdeas } from "@/lib/coach/blocks/hydrate-food-ideas";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const idea = {
  wish: "rice bowl", slot: "meal-2", items: [{
    name: "Chicken breast", foodRefId: "food-chicken", catalogFoodRevisionId: 71,
    grams: 120, kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
    macros: { kcal: 198, protein: 37.2, carbs: 0, fat: 4.3 }, verdict: "allowed" as const,
  }, {
    name: "Avocado", foodRefId: "food-avocado", catalogFoodRevisionId: 72,
    grams: 50, kcalPer100g: 160, proteinPer100g: 2, carbsPer100g: 8.5, fatPer100g: 14.7,
    macros: { kcal: 80, protein: 1, carbs: 4.3, fat: 7.4 }, verdict: "allowed" as const,
    addedFor: "fat" as const,
  }],
  totals: { kcal: 300, protein: 20, carbs: 40, fat: 8 },
  target: { kcal: 300, protein: 20, carbs: 40, fat: 8 },
  flagged: [], fitsTarget: true,
};

describe("food ideas block hydration", () => {
  it("wraps the composed cards produced by suggest_options", () => {
    expect(hydrateFoodIdeas("ideas-1", [idea])).toEqual({
      kind: "food_ideas", v: 1, id: "ideas-1", ideas: [idea],
    });
  });

  it("returns no block for an empty or malformed result", () => {
    expect(hydrateFoodIdeas("ideas-1", [])).toBeNull();
    expect(hydrateFoodIdeas("ideas-1", [{ wish: "model-only" }])).toBeNull();
  });

  it.each(["suggest_options", "compose_meal"])(
    "turns %s cards into a block and returns only a short model acknowledgement",
    (name) => {
      const hydrated = hydrateResolvedTool(name, {}, name === "compose_meal" ? idea : [idea], {
        admin: {} as never, userId: "user-1", date: "2026-09-19", tz: "America/Denver",
        context: null, profile: DEFAULT_PROFILE, newId: () => "ideas-2",
      });

      expect(hydrated.block).toMatchObject({ kind: "food_ideas", ideas: [idea] });
      expect(hydrated.data).toEqual({
        ok: true,
        block: "food_ideas",
        ideas: [{
          wish: "rice bowl",
          slot: "meal-2",
          itemNames: ["Chicken breast", "Avocado"],
          composerAdded: [{ name: "Avocado", for: "fat" }],
          fitsTarget: true,
        }],
      });
    },
  );
});
