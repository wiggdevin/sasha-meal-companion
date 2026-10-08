import { describe, expect, it } from "vitest";
import { emptyFacts } from "@/components/Onboarding/facts";
import { defaultSettings } from "@/lib/store";
import {
  applyFactsToSettings, buildOnboardingStateFromFacts, knownPreferenceFlags,
} from "./facts-bridge";

describe("facts bridge", () => {
  it("merges confirmed facts onto the existing settings without clearing untouched fields", () => {
    const base = { ...defaultSettings(), heightUnit: "cm" as const };
    const merged = applyFactsToSettings(base,
      { ...emptyFacts(), goal: "recomp", heightCm: 170, weightKg: 68 });
    expect(merged.goal).toBe("recomp");
    expect(merged.heightCm).toBe(170);
    expect(merged.weightKg).toBe(68);
    expect(merged.heightUnit).toBe("cm");
    expect(merged.sex).toBe(base.sex);
  });

  it("passes 'prefer not to say' through as Settings.sex's own real value (CONTRACT ONB2-L1"
    + " sex-unspecified, #493) — never a fabricated male/female guess", () => {
    const merged = applyFactsToSettings(defaultSettings(), { ...emptyFacts(), sex: "unspecified" });
    expect(merged.sex).toBe("unspecified");
  });

  it("passes a real sex value through unchanged", () => {
    const merged = applyFactsToSettings(defaultSettings(), { ...emptyFacts(), sex: "female" });
    expect(merged.sex).toBe("female");
  });

  it("drops an unknown diet flag rather than passing it through", () => {
    expect(knownPreferenceFlags(["vegan", "made_up_flag", "halal"]))
      .toEqual(["vegan", "halal"]);
    expect(knownPreferenceFlags(undefined)).toEqual([]);
  });

  it("builds an OnboardingState at step 5 carrying the known diet flags", () => {
    const settings = applyFactsToSettings(defaultSettings(), {
      ...emptyFacts(), goal: "lose_fat", sex: "male", birthYear: 1990, heightCm: 180, weightKg: 80,
    });
    const state = buildOnboardingStateFromFacts(settings,
      { ...emptyFacts(), goal: "lose_fat", dietFlags: ["vegetarian", "not_a_real_flag"] });
    expect(state.step).toBe(5);
    expect(state.flags).toEqual(["vegetarian"]);
    expect(state.goal).toBe("lose_fat");
    expect(state.body.birthYear).toBe("1990");
    // Question set v2 (V1): the pace is a required tap, never a silent default.
    expect(state.goalRateBpWeek).toBeNull();
    // V3: activity is never silently "moderate".
    expect(state.activityLevel).toBe("sedentary");
  });

  it("carries the beats' answers: pace, activity, training days, meals, first meal and country", () => {
    const settings = applyFactsToSettings(defaultSettings(), {
      ...emptyFacts(), goal: "lose_fat", sex: "male", birthYear: 1990, heightCm: 180, weightKg: 80,
    });
    const state = buildOnboardingStateFromFacts(settings, { ...emptyFacts(), goal: "lose_fat" }, {
      goalRateBpWeek: -25, activityLevel: "light", trainingWeekdays: [5, 1, 3],
      mealsPerDay: 4, firstMealTime: "07:30", countryCode: "US",
    });
    expect(state).toMatchObject({
      goalRateBpWeek: -25, activityLevel: "light", trainingWeekdays: [1, 3, 5],
      mealsPerDay: 4, firstMealTime: "07:30", countryCode: "US",
    });
  });

  it("carries a 'prefer not to say' sex answer through to the OnboardingState the write path"
    + " reads, so missingProfileFields never reports it as missing", () => {
    const settings = applyFactsToSettings(defaultSettings(),
      { ...emptyFacts(), sex: "unspecified", birthYear: 1990, heightCm: 180, weightKg: 80 });
    const state = buildOnboardingStateFromFacts(settings, { ...emptyFacts(), sex: "unspecified" });
    expect(state.body.sex).toBe("unspecified");
  });

  // GPT-6 Sol round-1 BLOCK: this shell never asks a dietary-flag question, so `facts.dietFlags`
  // is undefined on every real completion — the account's own already-saved flags (e.g. vegan)
  // must survive, not be silently cleared to [].
  it("preserves the account's existing diet flags when the facts flow never answered one", () => {
    const settings = { ...defaultSettings(), dietPrefs: { flags: ["vegan", "halal"] } };
    const state = buildOnboardingStateFromFacts(settings, { ...emptyFacts(), goal: "maintain" });
    expect(state.flags).toEqual(["vegan", "halal"]);
  });

  it("still replaces the flags when the facts flow explicitly answered a dietFlags question", () => {
    const settings = { ...defaultSettings(), dietPrefs: { flags: ["vegan"] } };
    const state = buildOnboardingStateFromFacts(settings, { ...emptyFacts(), dietFlags: ["halal"] });
    expect(state.flags).toEqual(["halal"]);
  });
});
