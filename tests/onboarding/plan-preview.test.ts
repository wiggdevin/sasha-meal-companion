// 2026-10-07 live QA defect 5: the onboarding preview must be Today's plan, from the picked foods.
import { describe, expect, it } from "vitest";
import { onboardingPlanPreview } from "@/lib/onboarding/plan-preview";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";
import { starterFood } from "@/lib/foods/starter";
import type { Settings } from "@/lib/types";

const macros = { kcal: 1622, protein: 136, carbs: 157, fat: 50 };
const settings = (): Settings => ({ ...defaultStore().settings, onboardedAt: "2026-10-08T03:38:52Z",
  trainingWeekdays: [], mealsPerDay: null, activeTargetProfile: { revision: 1, training: macros, rest: macros,
    pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Settings);
const PICKED = ["salmon-wild-sockeye-cooked", "egg-whole-large", "oatmeal-cooked", "white-rice-cooked",
  "broccoli-cooked", "olive-oil", "avocado"].map((id) => starterFood(id, "eats"));

describe("onboardingPlanPreview", () => {
  it("is exactly Today's resolveDay for the same settings, foods and date", () => {
    const preview = onboardingPlanPreview(settings(), PICKED, "2026-10-08");
    const store = defaultStore();
    store.settings = { ...settings(), ruleReviewReady: true };
    store.foods = Object.fromEntries(PICKED.map((food) => [food.id, food]));
    const today = resolveDay(store, "2026-10-08", 0, new Set(PICKED.map((food) => food.id)));
    expect(preview.meals.map((meal) => [meal.time, meal.name]))
      .toEqual(today.slots.filter((slot) => slot.meal).map((slot) => [slot.time, slot.meal!.name]));
    expect(preview.meals.length).toBeGreaterThan(0);
  });

  it("uses only the picked foods, with Today's slot clocks", () => {
    const names = new Set(PICKED.map((food) => food.name));
    const preview = onboardingPlanPreview(settings(), PICKED, "2026-10-08");
    expect(preview.meals[0].time).toBe("08:00");
    for (const meal of preview.meals) for (const part of meal.components) expect(names.has(part.name)).toBe(true);
  });

  it("leaves out avoided foods and writes nothing", () => {
    const avoided = PICKED.map((food, i) => i === 0 ? { ...food, status: "avoid" as const } : food);
    const preview = onboardingPlanPreview(settings(), avoided, "2026-10-08");
    expect(preview.meals.flatMap((meal) => meal.components.map((part) => part.name))).not.toContain(PICKED[0].name);
  });
});
