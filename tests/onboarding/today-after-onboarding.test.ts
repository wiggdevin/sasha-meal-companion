// onb3 (live QA 2026-10-08, bug 2): right after onboarding, Today asked the person to add foods
// ("Add a breakfast starch or fruit to Eats", "Nothing planned yet") although the server had just
// verified every pick. The pulled food rows carry `catalog_food_id: null`, which the phone mapped to
// `catalogFoodId: 0` (`Number(null)` is 0). The eligible projection only trusts a food-id match for
// a food with no catalog link, so every pulled food was dropped until the device's ref cache was
// backfilled under its new id, and Today planned from 0, then 2, of 11 verified foods. A reload
// (full cache) planned the preview's day. Today must plan the preview's day on its first read.
import { describe, expect, it } from "vitest";
import { dbFood } from "@/lib/food-db";
import { starterFood } from "@/lib/foods/starter";
import { eligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { onboardingPlanPreview } from "@/lib/onboarding/plan-preview";
import { buildCompletedSettings, createOnboardingState, onboardingReducer } from "@/lib/profile/onboarding-state";
import { resolveDay } from "@/lib/resolve";
import { defaultSettings, defaultStore, foodsFromSyncRows } from "@/lib/store";
import { settingsWithTargetRevision } from "@/lib/targets/revision";
import type { TargetRevision } from "@/lib/types";

const DATE = "2026-10-08";
const PICKS = ["chicken-breast-roasted", "turkey-breast-roasted", "ground-beef-90-10-cooked", "pork-tenderloin-roasted",
  "salmon-wild-sockeye-cooked", "white-rice-cooked", "brown-rice-cooked", "oatmeal-cooked", "potato-baked-with-skin",
  "broccoli-cooked", "olive-oil", "avocado"];

function candidate() {
  let state = createOnboardingState(defaultSettings());
  for (const action of [
    { type: "edit_body", key: "heightCm", value: "178" }, { type: "edit_body", key: "birthYear", value: "1990" },
    { type: "set_sex", value: "male" }, { type: "edit_weight", value: "185" },
    { type: "set_activity", value: "light" }, { type: "set_goal", value: "gain_muscle" },
  ] as const) state = onboardingReducer(state, action);
  return { ...buildCompletedSettings(defaultSettings(), state, new Date(2026, 9, 8, 9, 30)), mealsPerDay: 5 };
}

/** The account's rows as the first pull after the save mirrors them: server ids, no catalog link. */
function pulledRows() {
  const foods = PICKS.map((id, index) => {
    const db = dbFood(id)!;
    return { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, name: db.name,
      per_100g: { protein: db.per100g.protein, carbohydrate: db.per100g.carbs, fat_total: db.per100g.fat,
        energy_kcal: db.per100g.kcal },
      catalog_food_id: null, deleted_at: null, note: null, updated_at: "2026-10-08T21:25:14Z" };
  });
  const refs = foods.map((row, index) => ({ id: `ref-${index}`, user_food_id: row.id }));
  const prefs = refs.map((ref) => ({ food_ref_id: ref.id, status: "eats", role: null, no_cook: false,
    note: null, updated_at: "2026-10-08T21:25:14Z" }));
  return { foods, refs, prefs };
}

describe("Today right after onboarding", () => {
  it("maps a null catalog link to no link", () => {
    const { foods, prefs, refs } = pulledRows();
    for (const food of Object.values(foodsFromSyncRows(foods, prefs, refs))) {
      expect(food.catalogFoodId).toBeUndefined();
    }
    const linked = foodsFromSyncRows([{ ...foods[0], catalog_food_id: 1234 }], prefs, refs);
    expect(Object.values(linked)[0].catalogFoodId).toBe(1234);
    const missing = { ...foods[0] } as Record<string, unknown>;
    delete missing.catalog_food_id;
    expect(Object.values(foodsFromSyncRows([missing], prefs, refs))[0].catalogFoodId).toBeUndefined();
    // `Number("")` and `Number("  ")` are 0: neither is a link, nor is any non-integer value.
    for (const value of ["", "  ", "abc", 1.5, true, {}]) {
      expect(Object.values(foodsFromSyncRows([{ ...foods[0], catalog_food_id: value }], prefs, refs))[0]
        .catalogFoodId).toBeUndefined();
    }
  });

  it("keeps a catalog link of 0: the schema allows it, and it still needs a ref proof", () => {
    const { foods, prefs, refs } = pulledRows();
    for (const value of [0, "0"]) {
      const local = foodsFromSyncRows([{ ...foods[0], catalog_food_id: value }], prefs, refs);
      expect(Object.values(local)[0].catalogFoodId).toBe(0);
      const ids = eligibleLocalFoodIds(local, {}, {
        eligibleRefIds: [], eligibleFoodIds: [foods[0].id], eligibleCatalogFoodIds: [],
      });
      expect(ids.size).toBe(0);
    }
  });

  it("verifies every pulled food before the device's ref cache knows its new id", () => {
    const { foods, prefs, refs } = pulledRows();
    const local = foodsFromSyncRows(foods, prefs, refs);
    // The ref cache still holds only the onboarding picks' own `starter:` keys.
    const cache = Object.fromEntries(PICKS.map((id, index) => [`starter:${id}`, { userRefId: `ref-${index}` }]));
    const ids = eligibleLocalFoodIds(local, cache as never, {
      eligibleRefIds: refs.map((ref) => ref.id), eligibleFoodIds: foods.map((row) => row.id), eligibleCatalogFoodIds: [],
    });
    expect(ids.size).toBe(PICKS.length);
  });

  it("plans the preview's meals on its first read", () => {
    const settings = candidate();
    const picked = PICKS.map((id) => starterFood(id, "eats"));
    const preview = onboardingPlanPreview(settings, picked, DATE);
    expect(preview.emptySlots).toBe(0);

    const { foods, prefs, refs } = pulledRows();
    const store = defaultStore();
    store.foods = foodsFromSyncRows(foods, prefs, refs);
    const saved = settingsWithTargetRevision(settings, {
      ...(settings.activeTargetProfile as TargetRevision), id: "11111111-1111-4111-8111-000000000001",
      revision: 1, effectiveFrom: DATE,
    }, DATE);
    store.settings = { ...saved, ruleReviewReady: true };
    const verified = eligibleLocalFoodIds(store.foods, {}, {
      eligibleRefIds: refs.map((ref) => ref.id), eligibleFoodIds: foods.map((row) => row.id), eligibleCatalogFoodIds: [],
    });
    const today = resolveDay(store, DATE, 0, verified);
    const meals = today.slots.filter((slot) => slot.meal && slot.components.length > 0)
      .map((slot) => [slot.time, slot.meal!.name]);
    expect(meals).toHaveLength(5);
    expect(meals).toEqual(preview.meals.map((meal) => [meal.time, meal.name]));
  });

  it("still needs a ref proof for a catalog-linked food", () => {
    const { foods, prefs, refs } = pulledRows();
    const local = foodsFromSyncRows([{ ...foods[0], catalog_food_id: 1234 }], prefs, refs);
    const ids = eligibleLocalFoodIds(local, {}, {
      eligibleRefIds: [], eligibleFoodIds: [foods[0].id], eligibleCatalogFoodIds: [],
    });
    expect(ids.size).toBe(0);
  });
});
