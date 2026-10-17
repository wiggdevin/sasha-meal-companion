import { describe, expect, it } from "vitest";
import { isPackagedCatalogSource, policyCategoriesFor } from "@/lib/catalog/category-map";
import { namedAllergenHints } from "@/lib/policy/allergens";
import { evaluatePolicy, loadProfile } from "@/lib/policy/constraints";
import {
  STREAK_FOODS, STREAK_PREFIX, STREAK_RULES, STREAK_SOURCE,
} from "@/scripts/eval/coach-streak-foods";

// 2026-10-17 coach live pass rerun (docs/evals/2026-10-17-coach-live-pass-rerun.md): 41 of 57
// held items were `unverified` or `unchecked_id`, because the seed's rows were packaged
// (fdc_branded) and half the corpus foods were missing. Every seeded food must now reach a real
// verdict under the seed's own rules, judged the way food search judges a catalog hit.
const profile = loadProfile({ ...STREAK_RULES, avoid_food_ref_ids: [] });

function verdictOf(food: (typeof STREAK_FOODS)[number]) {
  // As searchFoods reads the seed: one seq-1 row whose raw text is the verbatim label, plus the
  // allergens its first ingredient's name names.
  const hasRows = food.ingredients !== undefined || (food.allergenTags?.length ?? 0) > 0;
  const firstName = food.ingredients?.split(/,(?![^(]*\))/)[0].trim() ?? food.description;
  const hints = hasRows ? namedAllergenHints(firstName, STREAK_RULES.avoid_allergens) : [];
  return evaluatePolicy(profile, {
    foodRefId: null,
    allergenTags: hasRows ? [...(food.allergenTags ?? []), ...hints] : null,
    ingredientsText: food.ingredients ?? null,
    ingredientsTextIsLabel: true,
    checkedAllergens: food.checked ?? [],
    foodName: food.description,
    foodBrand: null,
    packaged: isPackagedCatalogSource(STREAK_SOURCE),
    category: policyCategoriesFor({ description: food.description, category: null }),
    onEatsList: food.list === "eats",
    onAvoidList: food.list === "avoid",
  });
}

describe("coach streak seed foods", () => {
  it("seeds generic rows, not packaged products", () => {
    expect(isPackagedCatalogSource(STREAK_SOURCE)).toBe(false);
    expect(new Set(STREAK_FOODS.map((f) => f.sourceId)).size).toBe(STREAK_FOODS.length);
    expect(STREAK_FOODS.every((f) => f.sourceId.startsWith(STREAK_PREFIX))).toBe(true);
  });

  it("gives every seeded food a verdict, never unverified", () => {
    const open = STREAK_FOODS.filter((food) => verdictOf(food).verdict === "unverified")
      .map((food) => food.description);
    expect(open).toEqual([]);
  });

  it("clears the Eats foods the corpus suggests and logs", () => {
    const blocked = STREAK_FOODS.filter((f) => f.list === "eats")
      .filter((food) => verdictOf(food).verdict !== "allowed").map((f) => f.description);
    expect(blocked).toEqual([]);
  });

  it("keeps the foods that contain an avoided allergen blocked", () => {
    const reasons = Object.fromEntries(STREAK_FOODS
      .filter((f) => ["Spaghetti, cooked", "Bread, sourdough", "Cheese, cheddar",
        "Greek yogurt, plain", "Pizza, cheese", "Croissant, butter", "Spaghetti bolognese"]
        .includes(f.description))
      .map((food) => [food.description, verdictOf(food).verdict]));
    expect(Object.values(reasons).every((v) => v === "blocked")).toBe(true);
    expect(Object.keys(reasons)).toHaveLength(7);
  });

  it("names every food the corpus and the off-plan probe rely on", () => {
    const names = STREAK_FOODS.map((f) => f.description.toLowerCase()).join("|");
    for (const word of ["watermelon", "spaghetti", "chicken", "rice", "avocado", "cheddar",
      "pizza", "croissant", "bacon", "sourdough", "salmon", "tofu", "oatmeal", "oats", "blueberries",
      "eggs", "tortilla", "greek yogurt"]) {
      expect(names).toContain(word);
    }
  });
});
