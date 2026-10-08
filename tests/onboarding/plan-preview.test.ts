// 2026-10-07 live QA defect 5: the onboarding preview must be Today's plan, from the picked foods.
import { describe, expect, it } from "vitest";
import { onboardingPlanPreview } from "@/lib/onboarding/plan-preview";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";
import { starterFood } from "@/lib/foods/starter";
import type { Settings, TargetRevision } from "@/lib/types";
import { buildCompletedSettings, createOnboardingState, onboardingReducer } from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";
import { settingsWithTargetRevision, targetRevisionOn } from "@/lib/targets/revision";

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

// GPT-6 Sol BLOCK (onb2-p0): the reward preview ran `resolveDay` over the UNSAVED candidate from
// the real onboarding builder, which carries no server revision, so target resolution answered
// needs_profile and the preview listed no meals. The reported selection must preview meals, and
// the same first meals Today plans once the server's revision of that candidate is saved.
describe("onboardingPlanPreview over the real onboarding candidate", () => {
  const REPORTED = ["chicken-breast-roasted", "turkey-breast-roasted", "white-rice-cooked",
    "brown-rice-cooked", "olive-oil", "avocado-oil"].map((id) => starterFood(id, "eats"));
  const DATE = "2026-10-08";

  function candidate(): Settings {
    let state = createOnboardingState(defaultSettings());
    for (const action of [
      { type: "edit_body", key: "heightCm", value: "170" },
      { type: "edit_body", key: "birthYear", value: "1990" },
      { type: "set_sex", value: "female" },
      { type: "edit_weight", value: "170" },
      { type: "set_activity", value: "moderate" },
      { type: "set_goal", value: "recomp" },
    ] as const) state = onboardingReducer(state, action);
    return buildCompletedSettings(defaultSettings(), state, new Date(2026, 9, 8, 9, 30));
  }

  it("previews meals for the reported selection before the target is saved", () => {
    const settings = candidate();
    expect(typeof settings.activeTargetProfile?.revision).not.toBe("number");
    const preview = onboardingPlanPreview(settings, REPORTED, DATE);
    expect(preview.meals.length).toBeGreaterThan(0);
    expect(preview.emptySlots).toBe(0);
  });

  it("returns the same first meals Today plans after the save", () => {
    const settings = candidate();
    const preview = onboardingPlanPreview(settings, REPORTED, DATE);
    // The save: the server's revision of this candidate, mapped into the phone cache.
    const saved = settingsWithTargetRevision(settings, {
      ...(settings.activeTargetProfile as TargetRevision), id: "11111111-1111-4111-8111-000000000001",
      revision: 1, effectiveFrom: DATE,
    }, DATE);
    const store = defaultStore();
    store.settings = { ...saved, ruleReviewReady: true };
    store.foods = Object.fromEntries(REPORTED.map((food) => [food.id, food]));
    const today = resolveDay(store, DATE, 0, new Set(REPORTED.map((food) => food.id)));
    const todayMeals = today.slots.filter((slot) => slot.meal && slot.components.length > 0)
      .map((slot) => [slot.time, slot.meal!.name]);
    expect(todayMeals.length).toBeGreaterThan(0);
    expect(preview.meals.map((meal) => [meal.time, meal.name])).toEqual(todayMeals);
  });

  it("never leaks the preview target into the settings it was given", () => {
    const settings = candidate();
    const before = JSON.stringify(settings);
    onboardingPlanPreview(settings, REPORTED, DATE);
    expect(JSON.stringify(settings)).toBe(before);
    expect(targetRevisionOn(settings, DATE)).toBeNull();
  });
});

// Final Sol review BLOCK: a returning account's preview dropped its existing Eats, so the reward
// card and Today planned from different food sets.
describe("onboardingPlanPreview for a returning account", () => {
  const DATE = "2026-10-08";
  const own = { ...starterFood("chicken-breast-roasted", "eats"), id: "own-chicken", name: "Home roasted chicken" };

  it("plans from the account's verified Eats plus the picks, exactly as Today does after the save", () => {
    const account = defaultStore();
    account.foods = { [own.id]: own };
    const preview = onboardingPlanPreview(settings(), PICKED, DATE, { store: account, verified: new Set([own.id]) });

    const store = defaultStore();
    store.settings = { ...settings(), ruleReviewReady: true };
    store.foods = { [own.id]: own, ...Object.fromEntries(PICKED.map((food) => [food.id, food])) };
    const today = resolveDay(store, DATE, 0, new Set([own.id, ...PICKED.map((food) => food.id)]));
    expect(preview.meals.map((meal) => [meal.time, meal.name]))
      .toEqual(today.slots.filter((slot) => slot.meal && slot.components.length > 0)
        .map((slot) => [slot.time, slot.meal!.name]));
  });

  it("an existing food the server did not verify stays out, as it does on Today", () => {
    const account = defaultStore();
    account.foods = { [own.id]: own };
    const preview = onboardingPlanPreview(settings(), PICKED, DATE, { store: account, verified: null });
    expect(preview.meals.flatMap((meal) => meal.components.map((part) => part.name))).not.toContain(own.name);
  });

  it("a pick's mark applies to the account's same-name food (the membership rule)", () => {
    const account = defaultStore();
    const sameName = { ...PICKED[0], id: "own-salmon", status: "avoid" as const };
    account.foods = { [sameName.id]: sameName };
    const preview = onboardingPlanPreview(settings(), PICKED, DATE, { store: account, verified: new Set() });
    expect(preview.meals.length).toBeGreaterThan(0);
  });
});
