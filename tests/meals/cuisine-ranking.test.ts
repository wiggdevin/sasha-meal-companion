// onb3 (owner direction 2026-10-08): the account's stated cuisines (`user_settings.cuisines`) must
// visibly shape the plan, as ranking only. Before this, all 12 cuisines produced identical plates.
import { describe, expect, it } from "vitest";
import { starterFood } from "@/lib/foods/starter";
import { cuisineFactor, cuisineRanking } from "@/lib/meals/cuisine";
import { onboardingPlanPreview } from "@/lib/onboarding/plan-preview";
import { buildCompletedSettings, createOnboardingState, onboardingReducer } from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";
import type { Food } from "@/lib/foods";

const PICKS = ["chicken-breast-roasted", "ground-beef-90-10-cooked", "salmon-wild-sockeye-cooked", "egg-whole-large",
  "tofu-firm", "lentils-cooked", "black-beans-cooked", "white-rice-cooked", "brown-rice-cooked", "sweet-potato-baked",
  "potato-baked-with-skin", "oatmeal-cooked", "corn-tortilla", "whole-wheat-bread", "broccoli-cooked", "spinach-cooked",
  "green-beans-cooked", "avocado", "olive-oil", "almonds", "greek-yogurt-plain-nonfat", "banana", "blueberries"];
const WEEK = ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
const foods = PICKS.map((id) => starterFood(id, "eats"));

function settings(cuisines: string[] | null) {
  let state = createOnboardingState(defaultSettings());
  for (const action of [
    { type: "edit_body", key: "heightCm", value: "178" }, { type: "edit_body", key: "birthYear", value: "1990" },
    { type: "set_sex", value: "male" }, { type: "edit_weight", value: "185" },
    { type: "set_activity", value: "moderate" }, { type: "set_goal", value: "recomp" },
  ] as const) state = onboardingReducer(state, action);
  return { ...buildCompletedSettings(defaultSettings(), state, new Date(2026, 9, 8, 9, 30)), mealsPerDay: 4,
    cuisines: cuisines as never };
}

const week = (cuisines: string[] | null) => WEEK.map((date) =>
  onboardingPlanPreview(settings(cuisines), foods, date).meals.map((meal) => meal.name));

describe("stated cuisines shape the plan", () => {
  // Previews of one pool and one clock differ only through the cuisine, so this also proves the
  // planner's memo key carries it.
  it("two different cuisine sets give different plates over a week", () => {
    const american = week(["american"]);
    const latin = week(["latin_american"]);
    const southAsian = week(["south_asian", "mediterranean"]);
    const differs = (a: string[][], b: string[][]) => a.flat().filter((name, i) => name !== b.flat()[i]).length;
    expect(differs(american, latin)).toBeGreaterThanOrEqual(3);
    expect(differs(american, southAsian)).toBeGreaterThanOrEqual(3);
    // Each stated cuisine's own staples come forward: tortillas for Latin American, bread for American.
    const count = (plan: string[][], word: string) => plan.flat().filter((name) => name.includes(word)).length;
    expect(count(latin, "corn tortilla")).toBeGreaterThan(count(american, "corn tortilla"));
    expect(count(american, "whole wheat bread")).toBeGreaterThan(count(latin, "whole wheat bread"));
  });

  it("no stated cuisine is exactly the plan without the term", () => {
    expect(week([])).toEqual(week(null));
    expect(cuisineRanking([])).toBeUndefined();
    expect(cuisineRanking(["not_a_cuisine"])).toBeUndefined();
  });

  it("ranks only: never adds a food outside the pool, never penalizes one", () => {
    const names = new Set(foods.map((food) => food.name));
    for (const cuisines of [["japanese"], ["african", "caribbean"], ["italian"]]) {
      for (const day of WEEK.map((date) => onboardingPlanPreview(settings(cuisines), foods, date))) {
        expect(day.emptySlots).toBe(0);
        for (const meal of day.meals) for (const part of meal.components) expect(names.has(part.name)).toBe(true);
      }
    }
    const plain: Food = { ...foods[0], name: "Unlisted test food" };
    const factor = cuisineFactor([{ food: plain, part: "anchor", kcal: 300 }], "main", cuisineRanking(["japanese"])!);
    expect(factor).toBe(1);
  });

  it("an avoided food never appears whatever the cuisine favors", () => {
    const avoided = foods.map((food) => food.name.startsWith("Corn tortilla") ? { ...food, status: "avoid" as const } : food);
    for (const date of WEEK) {
      const day = onboardingPlanPreview(settings(["latin_american"]), avoided, date);
      expect(day.meals.flatMap((meal) => meal.components.map((part) => part.name)))
        .not.toContain(foods.find((food) => food.name.startsWith("Corn tortilla"))!.name);
    }
  });
});
