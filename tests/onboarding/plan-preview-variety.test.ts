// onb3 (live QA 2026-10-08, bug 1): the onboarding plan preview showed only meat with rice. The
// food surfaces offered the "carb" role in catalog order (every starch before any vegetable or
// fruit), so the capped deck, the top-pick chips and "pick for me" never put a vegetable or a fruit
// in Eats, and a closed-world plan can only use Eats. The preview must be varied and balanced when
// the person picks a varied set, and the pick surfaces must offer one.
import { describe, expect, it } from "vitest";
import { onboardingPlanPreview } from "@/lib/onboarding/plan-preview";
import { STARTERS, starterChoices, starterFillShortRoles, starterFood } from "@/lib/foods/starter";
import { starterFillOrder, starterPart } from "@/lib/foods/starter-variety";
import { partsOf } from "@/lib/meals/parts";
import { buildQueue } from "@/components/Onboarding/FallingFoodPile";
import { topPickChoices } from "@/components/Onboarding/FoodsTopPickChips";
import { buildCompletedSettings, createOnboardingState, onboardingReducer } from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";
import type { Food } from "@/lib/foods";

const PICKS = ["chicken-breast-roasted", "ground-beef-90-10-cooked", "salmon-wild-sockeye-cooked", "egg-whole-large",
  "white-rice-cooked", "brown-rice-cooked", "sweet-potato-baked", "potato-baked-with-skin", "oatmeal-cooked",
  "broccoli-cooked", "spinach-cooked", "green-beans-cooked", "avocado", "olive-oil", "almonds",
  "greek-yogurt-plain-nonfat", "banana", "blueberries"];
const DATES = ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];

function candidate(meals: number | null = null) {
  let state = createOnboardingState(defaultSettings());
  for (const action of [
    { type: "edit_body", key: "heightCm", value: "178" }, { type: "edit_body", key: "birthYear", value: "1990" },
    { type: "set_sex", value: "male" }, { type: "edit_weight", value: "185" },
    { type: "set_activity", value: "moderate" }, { type: "set_goal", value: "recomp" },
  ] as const) state = onboardingReducer(state, action);
  const settings = buildCompletedSettings(defaultSettings(), state, new Date(2026, 9, 8, 9, 30));
  return meals === null ? settings : { ...settings, mealsPerDay: meals };
}

const byName = (foods: readonly Food[]) => new Map(foods.map((food) => [food.name, food]));
const partOf = (food: Food | undefined) => (food ? partsOf(food)[0] : undefined);

describe("the plan preview from a varied pick set", () => {
  const foods = PICKS.map((id) => starterFood(id, "eats"));
  const names = byName(foods);

  for (const meals of [3, 5]) {
    it(`is varied and balanced over a week (${meals} meals a day)`, () => {
      const starches = new Set<string>();
      let mains = 0;
      let mainsWithVeg = 0;
      for (const date of DATES) {
        const preview = onboardingPlanPreview(candidate(meals), foods, date);
        expect(preview.emptySlots).toBe(0);
        expect(preview.meals).toHaveLength(meals);
        const anchors = new Set<string>();
        let dayFat = 0;
        for (const meal of preview.meals) {
          const parts = meal.components.map((part) => partOf(names.get(part.name)));
          for (const part of meal.components) {
            if (partOf(names.get(part.name)) === "starch") starches.add(part.name);
          }
          anchors.add(meal.components[0].name);
          if (parts.includes("fat")) dayFat += 1;
          // A lunch or dinner clock is a main plate (lib/meals/occasion.ts bands).
          if (meal.time >= "11:00" && meal.time < "21:00" && !parts.includes("fruit")) {
            mains += 1;
            if (parts.includes("veg")) mainsWithVeg += 1;
          }
        }
        // Distinct proteins lead the day's plates (D5: a repeat only beside an empty slot).
        expect(anchors.size).toBeGreaterThanOrEqual(Math.min(meals, 4));
        expect(dayFat).toBeGreaterThan(0);
      }
      expect(starches.size).toBeGreaterThanOrEqual(3);
      expect(mains).toBeGreaterThan(0);
      expect(mainsWithVeg / mains).toBeGreaterThanOrEqual(0.6);
    });
  }

  it("names only picked foods and never an avoided one", () => {
    const avoided = foods.map((food) => food.name === "Salmon, wild sockeye, cooked" ? { ...food, status: "avoid" as const } : food);
    for (const date of DATES) {
      const preview = onboardingPlanPreview(candidate(4), avoided, date);
      for (const meal of preview.meals) for (const part of meal.components) {
        expect(names.has(part.name)).toBe(true);
        expect(part.name).not.toBe("Salmon, wild sockeye, cooked");
      }
    }
  });
});

describe("the onboarding pick surfaces offer every plate part", () => {
  const choices = starterChoices([], { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null } as never);
  const parts = (ids: readonly string[]) => new Set(ids.map((id) => starterPart(STARTERS.find((item) => item.id === id)!)));

  it("the falling deck holds an anchor, a starch, a vegetable, a fruit and a fat, and distinct proteins", () => {
    const deck = buildQueue(choices);
    expect(deck.length).toBeLessThanOrEqual(14);
    expect([...parts(deck.map((item) => item.id))].sort()).toEqual(["anchor", "fat", "fruit", "starch", "veg"]);
    const proteins = deck.filter((item) => item.role === "protein").map((item) => item.id);
    // Five distinct proteins so a five-meal legacy plan can be chosen from the deck alone.
    expect(proteins.length).toBeGreaterThanOrEqual(5);
    expect(proteins).toContain("salmon-wild-sockeye-cooked");
    expect(proteins).not.toContain("turkey-breast-roasted"); // a second poultry waits behind other families
  });

  it("the top-pick chips offer a vegetable and a fruit beside the starches", () => {
    const picked = parts(topPickChoices(choices).map((item) => item.id));
    for (const part of ["anchor", "starch", "veg", "fruit", "fat"]) expect(picked.has(part as never)).toBe(true);
  });

  it("pick for me fills the carbs with a starch and a vegetable, and the fats with two kinds", () => {
    const added = starterFillShortRoles(choices, {}, { protein: 5 }, new Set(), starterFillOrder);
    const carbs = added.filter((id) => STARTERS.find((item) => item.id === id)!.role === "carb");
    expect([...parts(carbs)].sort()).toEqual(["starch", "veg"]);
    expect(added).toContain("olive-oil");
    expect(added).not.toContain("avocado-oil");
    expect(added.filter((id) => STARTERS.find((item) => item.id === id)!.role === "protein")).toHaveLength(5);
  });

  it("pick for me after a starch tap adds a vegetable, not a second starch", () => {
    const added = starterFillShortRoles(choices, { "white-rice-cooked": "eats" }, 2, new Set(), starterFillOrder);
    const carbs = added.filter((id) => STARTERS.find((item) => item.id === id)!.role === "carb");
    expect(carbs).toHaveLength(1);
    expect(starterPart(STARTERS.find((item) => item.id === carbs[0])!)).toBe("veg");
  });
});
