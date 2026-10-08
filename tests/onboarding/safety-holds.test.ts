// Onboarding v2 G7 + G1 on the phone: the safety round's taps travel in the constraint patch,
// are written BEFORE the target revision, and a held account saves no pace.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { defaultSettings } from "@/lib/store";
import {
  buildCompletedSettings, constraintPatchForFlags, createOnboardingState, missingProfileFields,
  onboardingReducer,
} from "@/lib/profile/onboarding-state";
import { persistCompletedOnboarding } from "@/lib/profile/onboarding-client";
import { AdultOnlyError, eligibilityFromSafetyAnswers } from "@/lib/profile/rate-eligibility";

const NOW = new Date(2026, 9, 8, 9, 30);

beforeEach(async () => {
  await resetTestAccount();
});

function losingState(birthYear = "1991") {
  let state = createOnboardingState(defaultSettings());
  for (const action of [
    { type: "edit_body", key: "heightCm", value: "163" },
    { type: "edit_body", key: "birthYear", value: birthYear },
    { type: "set_sex", value: "female" },
    { type: "edit_weight", value: "170" },
    { type: "set_activity", value: "light" },
    { type: "set_goal", value: "lose_fat" },
  ] as const) state = onboardingReducer(state, action);
  return state;
}

const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
  conditions: ["IBS"], notes: null };

describe("constraintPatchForFlags conditions", () => {
  it("adds the safety entries to the account's own list without duplicates", () => {
    expect(constraintPatchForFlags([], profile, ["Pregnant", "IBS", "  "]))
      .toEqual({ conditions: ["IBS", "Pregnant"] });
    expect(constraintPatchForFlags([], profile, ["IBS"])).toBeNull();
    expect(constraintPatchForFlags([], profile)).toBeNull();
  });
});

describe("a held account in onboarding", () => {
  const held = eligibilityFromSafetyAnswers({ pregnancy: "breastfeeding" });

  it("needs no pace and saves none; the preview holds maintenance", () => {
    const state = { ...losingState(), goalRateBpWeek: null };
    expect(missingProfileFields(state)).toContain("goal rate");
    expect(missingProfileFields(state, held)).toEqual([]);
    const settings = buildCompletedSettings(defaultSettings(), losingState(), NOW, held);
    expect(settings.goal).toBe("lose_fat");
    expect(settings.goalRateBpWeek).toBeNull();
    expect(settings.activeTargetProfile?.inputs.goalRateBpWeek).toBe(0);
    const free = buildCompletedSettings(defaultSettings(), losingState(), NOW);
    expect(free.goalRateBpWeek).toBe(-50);
    expect(settings.activeTargetProfile!.training.kcal)
      .toBeGreaterThan(free.activeTargetProfile!.training.kcal);
  });

  it("refuses to build a plan for an age under 18", () => {
    expect(() => buildCompletedSettings(defaultSettings(), losingState("2010"), NOW))
      .toThrow(AdultOnlyError);
  });

  it("writes the hold before the target revision", async () => {
    const order: string[] = [];
    const saveConstraints = vi.fn(async (patch: Record<string, unknown>) => {
      order.push(`constraints:${JSON.stringify(patch.conditions)}`);
      return { status: "ok" as const, profile: { ...profile, conditions: patch.conditions as string[] },
        rev: 1 };
    });
    const result = await persistCompletedOnboarding(defaultSettings(), losingState(), NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => { order.push("target"); return undefined; }),
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => ({ profile, rev: 0 })),
      saveConstraints,
      localDate: () => "2026-10-08",
      hasWeighIn: () => true,
    }, { pregnancy: "pregnant" });
    expect(order).toEqual(['constraints:["IBS","Pregnant"]', "target"]);
    expect(saveConstraints).toHaveBeenCalledTimes(1);
    expect(result.constraintsSaved).toBe(true);
    expect(result.settings.goalRateBpWeek).toBeNull();
  });

  it("writes nothing else when the hold cannot be saved", async () => {
    const saveSynced = vi.fn(async () => undefined);
    const result = await persistCompletedOnboarding(defaultSettings(), losingState(), NOW, {
      saveLocal: vi.fn(),
      saveSynced,
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-10-08",
      hasWeighIn: () => true,
    }, { clinicianDiet: true });
    expect(result.constraintsSaved).toBe(false);
    expect(saveSynced).not.toHaveBeenCalled();
  });
});

describe("Your day: first meal time", () => {
  it("saves the first meal as the whole-day shift for the chosen meal count", () => {
    let state = onboardingReducer(losingState(), { type: "set_meals_per_day", value: 3 });
    state = onboardingReducer(state, { type: "set_first_meal_time", value: "06:30" });
    expect(onboardingReducer(state, { type: "set_first_meal_time", value: "6:30" })).toBe(state);
    const settings = buildCompletedSettings(defaultSettings(), state, NOW);
    expect(settings.shiftMinutes).toBe(-90);
    expect(settings.mealsPerDay).toBe(3);
    expect(buildCompletedSettings(defaultSettings(), losingState(), NOW).shiftMinutes)
      .toBe(defaultSettings().shiftMinutes);
  });
});

describe("the country chip (ruling 2026-10-08)", () => {
  it("writes the country only from a chip the flow showed, never by default", async () => {
    const { ONBOARDING_COUNTRY_CHIP } = await import("@/lib/profile/onboarding-state");
    expect(createOnboardingState(defaultSettings()).countryCode).toBeUndefined();
    expect(buildCompletedSettings(defaultSettings(), losingState(), NOW).countryCode)
      .toBe(defaultSettings().countryCode);
    const shown = onboardingReducer(losingState(), { type: "set_country", value: ONBOARDING_COUNTRY_CHIP });
    expect(buildCompletedSettings(defaultSettings(), shown, NOW).countryCode).toBe("US");
    const off = onboardingReducer(shown, { type: "set_country", value: null });
    expect(buildCompletedSettings(defaultSettings(), off, NOW).countryCode).toBeNull();
    expect(onboardingReducer(shown, { type: "set_country", value: "usa" })).toBe(shown);
  });
});
