/**
 * A realistic Eats list for the meal-template tests (2026-10-03 owner report), per 100 g from
 * USDA SR Legacy rounded: proteins that suit breakfast and dinner, starches, vegetables, fats and
 * fruit, so a card can only look right by choosing well.
 */
import { vi } from "vitest";
import type { FoodHit } from "@/lib/coach/executors";
import type { SuggestPorts } from "@/lib/coach/suggest";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";
import type { MealClockPorts } from "@/lib/coach/meal-type";
import type { ConstraintProfile } from "@/lib/policy/constraints";

export const OPEN_PROFILE: ConstraintProfile = {
  avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
};

let n = 0;
export function food(
  name: string, per100: [number, number, number, number], over: Partial<FoodHit> = {},
): FoodHit {
  n += 1;
  const [kcal, protein, carbs, fat] = per100;
  return {
    foodRefId: `5a1b1a2c-0000-4000-8000-${String(n).padStart(12, "0")}`, name, brand: null,
    kcalPer100g: kcal, proteinPer100g: protein, carbsPer100g: carbs, fatPer100g: fat,
    prefStatus: "eats", catalogFoodRevisionId: n, allergenTags: [], category: [], portionGrams: 100,
    ...over,
  };
}

export const F = {
  scallopsSea: food("Scallops, sea, cooked", [111, 20.5, 5.4, 0.8]),
  scallopsBay: food("Scallops, bay, cooked", [111, 20.5, 5.4, 0.8]),
  chicken: food("Chicken breast, cooked", [165, 31, 0, 3.6]),
  salmon: food("Salmon, Atlantic, cooked", [206, 22, 0, 12]),
  cod: food("Cod, cooked", [105, 23, 0, 0.9]),
  steak: food("Beef, top sirloin, steak, cooked", [200, 30, 0, 8]),
  eggs: food("Eggs, whole, cooked", [155, 12.6, 1.1, 10.6], { portionGrams: 50 }),
  yogurt: food("Greek yogurt, plain, nonfat", [59, 10, 3.6, 0.4], { portionGrams: 170 }),
  rice: food("Rice, white, cooked", [130, 2.7, 28, 0.3]),
  potato: food("Potatoes, baked", [93, 2.5, 21, 0.1]),
  pasta: food("Pasta, cooked", [158, 5.8, 31, 0.9]),
  toast: food("Bread, whole wheat", [252, 12.4, 43, 3.5], { portionGrams: 32 }),
  oats: food("Oats", [389, 16.9, 66, 6.9], { portionGrams: 40 }),
  broccoli: food("Broccoli, cooked", [35, 2.4, 7.2, 0.4]),
  asparagus: food("Asparagus, cooked", [22, 2.4, 4.1, 0.2]),
  spinach: food("Spinach, raw", [23, 2.9, 3.6, 0.4]),
  banana: food("Banana, raw", [89, 1.1, 23, 0.3], { portionGrams: 118 }),
  blueberries: food("Blueberries, raw", [57, 0.7, 14.5, 0.3], { portionGrams: 148 }),
  avocado: food("Avocados, raw", [160, 2, 8.5, 14.7], { portionGrams: 15 }),
  oil: food("Oil, olive", [884, 0, 0, 100], { portionGrams: 14 }),
  almonds: food("Almonds", [579, 21, 22, 50], { portionGrams: 28 }),
};

export const PROTEINS = [F.scallopsBay, F.scallopsSea, F.chicken, F.salmon, F.cod, F.steak, F.eggs, F.yogurt];

/** A 5-meal day (2200 kcal) and a 3-meal day (2400 kcal), one slot each. */
export const FIVE_MEAL = { kcal: 440, protein: 35, carbs: 45, fat: 13 };
export const THREE_MEAL = { kcal: 800, protein: 60, carbs: 85, fat: 24 };

export function searchOver(foods: readonly FoodHit[]) {
  return vi.fn(async (_userId: string, query: string, limit = 3) => foods
    .filter((hit) => hit.name.toLowerCase() === query.toLowerCase()).slice(0, limit));
}

export function suggestPorts(options: {
  foods?: FoodHit[]; anchors?: FoodHit[]; target: typeof FIVE_MEAL; clock?: string | null;
  profile?: ConstraintProfile;
}): SuggestPorts & MealClockPorts {
  const foods = options.foods ?? Object.values(F);
  const anchors = options.anchors ?? PROTEINS.filter((hit) => foods.includes(hit));
  return {
    userId: "u1", profile: options.profile ?? OPEN_PROFILE, target: async () => options.target,
    eatsNames: async () => foods.map((hit) => hit.name),
    eatsAnchors: async () => anchors.map((hit) => hit.name),
    searchFoods: searchOver(foods),
    systemOne: async () => null,
    slotClock: async () => options.clock ?? null,
    suggestionEvidence: async (_userId, items) => ({
      status: "ready", preferenceFlags: [],
      byIdentity: Object.fromEntries(items.map((item) => {
        const hit = foods.find((row) => row.foodRefId === item.foodRefId);
        return [suggestionFoodIdentity(item), {
          allergenTags: hit?.allergenTags ?? [], policyCategories: [], noCook: null, onEatsList: true,
          onAvoidList: false, role: "protein" as const, foodName: hit?.name ?? null, foodBrand: null,
          packaged: false, ingredientsText: "",
          facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
        }];
      })),
    }),
  };
}
