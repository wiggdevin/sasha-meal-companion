import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import OnboardingFlow, {
  isBodyStepComplete, isNextDisabled, OnboardingNotice,
} from "@/components/Onboarding/OnboardingFlow";
import {
  ActivityStep, BodyStep, GoalStep, PlanStep, PREFERENCE_POLICY_COPY, PreferencesStep,
  toggleCookingEffort,
} from "@/components/Onboarding/OnboardingSteps";
import FoodsStep from "@/components/Onboarding/FoodsStep";
import { saveConstraints as putConstraints, type Profile } from "@/lib/constraints-client";
import { defaultSettings } from "@/lib/store";
import { deriveTargets, energyProfileFrom } from "@/lib/profile/energy";
import {
  buildCompletedSettings,
  buildSkippedSettings,
  constraintPatchForFlags,
  createOnboardingState,
  advisoryFlags,
  enforcedFlags,
  missingProfileFields,
  onboardingReducer,
  type OnboardingState,
} from "@/lib/profile/onboarding-state";
import {
  CONSTRAINT_SAVE_WARNING, CONSTRAINTS_UNAVAILABLE,
  persistCompletedOnboarding, persistSkippedOnboarding,
} from "@/lib/profile/onboarding-client";
import {
  classifyDietaryPreferences, createPreferenceClassifier, suggestedPreferenceFlags,
  type PrefsResponse,
} from "@/lib/profile/prefs-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

const NOW = new Date(2026, 8, 19, 9, 30);

// Phase 9 §0.1: `persistCompletedOnboarding`/`persistSkippedOnboarding` call `accountHandle()`
// themselves (lib/device/account.ts, real here — only their `deps` are doubles in this file), so
// every test that reaches them needs a bound account first.
beforeEach(async () => {
  await resetTestAccount();
});

function completeState() {
  let state = createOnboardingState(defaultSettings());
  const actions = [
    { type: "edit_body", key: "heightCm", value: "165" },
    { type: "edit_body", key: "birthYear", value: "1996" },
    { type: "edit_body", key: "bodyFatPct", value: "19.5" },
    { type: "set_sex", value: "female" },
    { type: "edit_weight", value: "132.277" },
    { type: "set_activity", value: "moderate" },
    { type: "set_goal", value: "recomp" },
    { type: "set_prefs_text", value: "Vegetarian and no shellfish" },
    { type: "toggle_flag", flag: "vegetarian" },
    { type: "toggle_flag", flag: "no_shellfish" },
  ] as const;
  for (const action of actions) state = onboardingReducer(state, action);
  return state;
}

describe("onboarding completion", () => {
  it("explains when rules leave fewer than two starter proteins before Foods can advance", () => {
    const markup = renderToStaticMarkup(createElement(FoodsStep, {
      choices: [], marks: {}, onMark: () => {},
    }));
    expect(markup).toContain("Your current food rules leave 0 starter proteins");
    expect(markup).toContain("Go Back to Dietary preferences");
    expect(markup).toContain("Skip for now");
  });

  it("persists a chosen two-meal layout and rejects counts outside 2–6", () => {
    const base = defaultSettings();
    const state = completeState();
    const chosen = onboardingReducer(state, { type: "set_meals_per_day", value: 2 });
    expect(buildCompletedSettings(base, chosen, NOW).mealsPerDay).toBe(2);
    expect(onboardingReducer(chosen, { type: "set_meals_per_day", value: 1 })).toBe(chosen);
    expect(onboardingReducer(chosen, { type: "set_meals_per_day", value: 7 })).toBe(chosen);
  });

  it("starts in feet/inches and pounds and reopens a stored weight in pounds", () => {
    const empty = createOnboardingState(defaultSettings());
    expect(empty).toMatchObject({ heightUnit: "ft_in", weightUnit: "lb", weight: "" });

    const existing = createOnboardingState({ ...defaultSettings(), heightCm: 165.1, weightKg: 60 });
    expect(existing).toMatchObject({
      heightUnit: "ft_in",
      weightUnit: "lb",
      weight: "132.3",
      body: { heightCm: "165.1" },
    });
  });

  it("writes the required profile, derived targets, onboarding stamp, and one weigh-in", async () => {
    const state = completeState();
    const base = defaultSettings();
    const settings = buildCompletedSettings(base, state, NOW);
    const saveLocal = vi.fn();
    const saveSynced = vi.fn(async () => undefined);
    const saveWeighIn = vi.fn(async () => null);
    const loadConstraints = vi.fn(async () => ({
      rev: 4,
      profile: {
        avoid_allergens: ["gluten", "dairy", "apple"],
        avoid_food_ref_ids: [],
        banned_categories: [],
        conditions: [],
        notes: null,
      },
    }));
    const savedProfile = {
      ...(await loadConstraints())!.profile,
      avoid_allergens: ["gluten", "dairy", "apple", "shellfish"],
    };
    const saveConstraints = vi.fn((patch, rev) => putConstraints(patch, rev, {
      fetchImpl: vi.fn(async () => Response.json({ profile: savedProfile, rev: 5 })),
    }));

    const result = await persistCompletedOnboarding(base, state, NOW, {
      saveLocal,
      saveSynced,
      saveWeighIn,
      loadConstraints,
      saveConstraints,
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(settings).toMatchObject({
      sex: "female",
      birthYear: 1996,
      heightCm: 165,
      weightKg: 60,
      activityLevel: "moderate",
      goal: "recomp",
      bodyFatPct: 19.5,
      // D1 §6.3: onboarding preselects no training day, so completeState() names none.
      trainingWeekdays: [],
      dietPrefs: { text: "Vegetarian and no shellfish", flags: ["vegetarian", "no_shellfish"] },
      onboardedAt: NOW.toISOString(),
    });
    // The numbers themselves are the revision authority's (AGENTS.md "Source of truth for
    // numbers"); tests/targets owns them. What onboarding owes is a candidate derived from THIS
    // profile — and with no training day chosen, a rest-only week, so both day types resolve the
    // same and the floor-safe protein figure still stands.
    expect(settings.activeTargetProfile?.training).toEqual(settings.activeTargetProfile?.rest);
    expect(settings.activeTargetProfile?.training.protein)
      .toBe(deriveTargets(energyProfileFrom(settings), NOW, 0).rest.protein);
    expect(saveLocal).toHaveBeenCalledOnce();
    expect(saveLocal).toHaveBeenCalledWith(settings);
    expect(saveSynced).toHaveBeenCalledWith(settings, "complete", []);
    expect(saveWeighIn).toHaveBeenCalledOnce();
    expect(saveWeighIn).toHaveBeenCalledWith("2026-09-19", expect.closeTo(132.277, 3));
    expect(saveConstraints).toHaveBeenCalledWith({
      baseRev: 4,
      avoidAllergens: ["gluten", "dairy", "apple", "shellfish"],
    }, 4);
    expect(result).toEqual({ settings, constraintsSaved: true });
  });

  it("skip changes only onboardedAt and leaves targets and profile untouched", () => {
    const activeTargetProfile = {
      training: { kcal: 2200, protein: 120, carbs: 230, fat: 89 },
      rest: { kcal: 1800, protein: 120, carbs: 140, fat: 84 },
    };
    const base = { ...defaultSettings(), sex: "male" as const, heightCm: 180,
      trainingKcal: 2300, activeTargetProfile };

    const skipped = buildSkippedSettings(base, NOW);

    expect(skipped).toEqual({ ...base, onboardedAt: NOW.toISOString() });
    expect(skipped.activeTargetProfile).toBe(activeTargetProfile);
  });

  it("syncs only the plan pin the user changed", async () => {
    let state = completeState();
    state = onboardingReducer(state, { type: "edit_plan", field: "restKcal", value: 1900 });
    const saveSynced = vi.fn(async () => undefined);

    const result = await persistCompletedOnboarding(defaultSettings(), state, NOW, {
      saveLocal: vi.fn(),
      saveSynced,
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(result.settings.restKcal).toBe(1900);
    expect(result.settings.trainingKcal).toBeNull();
    expect(result.settings.proteinG).toBeNull();
    expect(saveSynced).toHaveBeenCalledWith(result.settings, "complete", ["restKcal"]);
  });

  /**
   * Grok pass 1 on T2, FIX 2. A skip IS onboarding completion (D1 §6.1): it stamps `onboarded_at`,
   * which is what releases the forced gate, so it must leave the same all-empty
   * `constraint_profiles` row behind. It used to stamp and leave no row at all.
   */
  const EMPTY_PROFILE: Profile = {
    avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
    conditions: [], notes: null,
  };

  function skipDeps(loaded: { profile: Profile; rev: number } | null = {
    profile: EMPTY_PROFILE, rev: 0,
  }) {
    return {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      loadConstraints: vi.fn(async () => loaded),
      saveConstraints: vi.fn(async () => ({
        status: "ok" as const, profile: EMPTY_PROFILE, rev: 1,
      })),
      openFoodWorld: vi.fn(async () => {}),
    };
  }

  it("syncs skip as an onboarding stamp plus the account's empty constraint row", async () => {
    const deps = skipDeps();
    const base = { ...defaultSettings(), heightCm: 165, activeTargetProfile: {
      training: { kcal: 2200, protein: 120, carbs: 230, fat: 89 },
      rest: { kcal: 1800, protein: 120, carbs: 140, fat: 84 },
    } };

    const saved = await persistSkippedOnboarding(base, NOW, deps);

    expect(deps.saveConstraints).toHaveBeenCalledWith({ baseRev: 0 }, 0);
    expect(deps.saveLocal).toHaveBeenCalledWith(saved);
    expect(deps.saveSynced).toHaveBeenCalledWith(saved, "skip");
    expect(saved.heightCm).toBe(165);
    expect(saved.activeTargetProfile).toBe(base.activeTargetProfile);
  });

  it("does not stamp onboarded_at when the skip's constraint row could not be written", async () => {
    const deps = skipDeps(null);

    await expect(persistSkippedOnboarding(defaultSettings(), NOW, deps))
      .rejects.toThrow(CONSTRAINTS_UNAVAILABLE);
    expect(deps.saveSynced).not.toHaveBeenCalled();
    expect(deps.saveLocal).not.toHaveBeenCalled();
  });

  it("opens the food world on a FIRST skip, never on a later re-skip (W13, D14)", async () => {
    const deps = skipDeps();
    await persistSkippedOnboarding({ ...defaultSettings(), onboardedAt: null }, NOW, deps);
    expect(deps.openFoodWorld).toHaveBeenCalledTimes(1);

    deps.openFoodWorld.mockClear();
    await persistSkippedOnboarding(
      { ...defaultSettings(), onboardedAt: "2026-09-18T00:00:00.000Z" }, NOW, deps);
    expect(deps.openFoodWorld).not.toHaveBeenCalled();
  });

  it("gives a chosen goal its default rate, lets the user change it, and keeps it (step D)", () => {
    let state = completeState();
    state = onboardingReducer(state, { type: "set_goal", value: "lose_fat" });
    expect(state.goalRateBpWeek).toBe(-50);
    expect(renderToStaticMarkup(createElement(GoalStep, { state, dispatch: () => {} })))
      .toContain('aria-label="Goal rate"');
    state = onboardingReducer(state, { type: "set_goal_rate", value: -25 });
    expect(state.goalRateBpWeek).toBe(-25);
    // Re-choosing the same goal keeps the confirmed rate; a different goal resets it.
    state = onboardingReducer(state, { type: "set_goal", value: "lose_fat" });
    expect(state.goalRateBpWeek).toBe(-25);
    expect(buildCompletedSettings(defaultSettings(), state, NOW).goalRateBpWeek).toBe(-25);
    state = onboardingReducer(state, { type: "set_goal", value: "maintain" });
    expect(state.goalRateBpWeek).toBe(0);
    expect(renderToStaticMarkup(createElement(GoalStep, { state, dispatch: () => {} })))
      .not.toContain('aria-label="Goal rate"');
  });

  it("makes an existing loss account confirm a rate when it redoes setup", () => {
    const state = createOnboardingState({ ...defaultSettings(), sex: "female", birthYear: 1996,
      heightCm: 165, weightKg: 60, activityLevel: "moderate", goal: "lose_fat" });
    expect(state.goalRateBpWeek).toBeNull();
    expect(missingProfileFields(state)).toEqual(["goal rate"]);
    expect(createOnboardingState({ ...defaultSettings(), goal: "recomp" }).goalRateBpWeek).toBe(0);
  });

  it("names the rate and the plan limit on the plan step", () => {
    let state = completeState();
    state = onboardingReducer(state, { type: "set_goal", value: "lose_fat" });
    state = onboardingReducer(state, { type: "set_goal_rate", value: -75 });
    const markup = renderToStaticMarkup(createElement(PlanStep, { state,
      base: defaultSettings(), dispatch: () => {} }));
    expect(markup).toContain("losing 0.75% of body weight a week");
    expect(markup).toContain("exceeds the plan limit");
    expect(markup).not.toContain("goal offset");
  });

  it("names every required field missing from the plan step", () => {
    expect(missingProfileFields(createOnboardingState(defaultSettings()))).toEqual([
      "sex", "birth year", "height", "weight", "activity level", "goal",
    ]);
  });

  it("converts a pounds draft to kilograms before storing it", () => {
    let state = createOnboardingState(defaultSettings());
    state = onboardingReducer(state, { type: "set_weight_unit", value: "lb" });
    state = onboardingReducer(state, { type: "edit_weight", value: "132.277" });
    state = onboardingReducer(state, { type: "edit_body", key: "heightCm", value: "165" });
    state = onboardingReducer(state, { type: "edit_body", key: "birthYear", value: "1996" });
    state = onboardingReducer(state, { type: "set_sex", value: "female" });
    state = onboardingReducer(state, { type: "set_activity", value: "moderate" });
    state = onboardingReducer(state, { type: "set_goal", value: "maintain" });

    expect(buildCompletedSettings(defaultSettings(), state, NOW).weightKg).toBeCloseTo(60, 3);
  });

  it("keeps unit preferences on the completed settings", () => {
    let state = completeState();
    state = onboardingReducer(state, { type: "set_height_unit", value: "cm" });
    state = onboardingReducer(state, { type: "set_weight_unit", value: "kg" });

    expect(buildCompletedSettings(defaultSettings(), state, NOW))
      .toMatchObject({ heightUnit: "cm", weightUnit: "kg" });
  });

  it("does not write another weigh-in when settings re-entry keeps today's stored weight", async () => {
    const state: OnboardingState = { ...completeState(), flags: ["halal"] };
    const saveWeighIn = vi.fn(async () => null);

    await persistCompletedOnboarding({ ...defaultSettings(), weightKg: 60 }, state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn,
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-19",
      hasWeighIn: () => true,
      openFoodWorld: async () => {},
    });

    expect(saveWeighIn).not.toHaveBeenCalled();
  });

  it("writes the same stored weight when today has no weigh-in yet", async () => {
    const state: OnboardingState = { ...completeState(), flags: ["halal"] };
    const saveWeighIn = vi.fn(async () => null);

    await persistCompletedOnboarding({ ...defaultSettings(), weightKg: 60 }, state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn,
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(saveWeighIn).toHaveBeenCalledOnce();
  });

  // Audit 2026-10-10 A089: Settings › Edit profile re-runs this save with the profile's own
  // `weight_kg`, which no weigh-in updates. Unchanged, it is not a new reading.
  it("never logs an unchanged profile weight as a weigh-in on an onboarded account", async () => {
    const state: OnboardingState = { ...completeState(), flags: ["halal"] };
    const saveWeighIn = vi.fn(async () => null);
    const base = { ...defaultSettings(), weightKg: 60, onboardedAt: "2026-09-01T08:00:00.000Z" };

    await persistCompletedOnboarding(base, state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn,
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(saveWeighIn).not.toHaveBeenCalled();
  });

  // Sol review (PR #62) WARN: the form reads a seeded weight back rounded to the gram.
  it("never logs an untouched non-integer profile weight as a weigh-in", async () => {
    const base = { ...defaultSettings(), sex: "female" as const, birthYear: 1996, heightCm: 165,
      weightKg: 70.1234, activityLevel: "moderate" as const, goal: "recomp" as const,
      onboardedAt: "2026-09-01T08:00:00.000Z" };
    const state = createOnboardingState(base);
    const saveWeighIn = vi.fn(async () => null);

    await persistCompletedOnboarding(base, state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn,
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(saveWeighIn).not.toHaveBeenCalled();
  });

  it("logs a weight the onboarded account changed in Edit profile", async () => {
    const state: OnboardingState = { ...completeState(), flags: ["halal"] };
    const saveWeighIn = vi.fn(async () => null);
    const base = { ...defaultSettings(), weightKg: 64, onboardedAt: "2026-09-01T08:00:00.000Z" };

    await persistCompletedOnboarding(base, state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn,
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-19",
      hasWeighIn: () => true,
      openFoodWorld: async () => {},
    });

    expect(saveWeighIn).toHaveBeenCalledOnce();
  });

  it("writes a changed weight even when today already has a weigh-in", async () => {
    const state: OnboardingState = { ...completeState(), flags: ["halal"] };
    const saveWeighIn = vi.fn(async () => null);

    await persistCompletedOnboarding({ ...defaultSettings(), weightKg: 59 }, state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn,
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-19",
      hasWeighIn: () => true,
      openFoodWorld: async () => {},
    });

    expect(saveWeighIn).toHaveBeenCalledOnce();
  });
});

describe("dietary preference constraint mapping", () => {
  const profile = {
    avoid_allergens: ["gluten", "dairy", "apple"],
    avoid_food_ref_ids: [],
    banned_categories: [],
    conditions: [],
    notes: null,
  };

  it("maps no_shellfish to the shellfish allergen switch", () => {
    expect(constraintPatchForFlags(["no_shellfish"], profile)).toEqual({
      avoidAllergens: ["gluten", "dairy", "apple", "shellfish"],
    });
  });

  it("maps no_peanuts to the supported peanut allergen key", () => {
    expect(constraintPatchForFlags(["no_peanuts"], profile)).toEqual({
      avoidAllergens: ["gluten", "dairy", "apple", "peanut"],
    });
  });

  it("exposes exactly the flags backed by real policy keys", () => {
    expect(enforcedFlags()).toEqual([
      "vegetarian", "vegan", "pescatarian", "no_pork", "no_beef",
      "no_shellfish", "no_eggs", "no_soy", "no_peanuts", "low_fodmap",
      "halal", "kosher",
    ]);
    expect(advisoryFlags()).toEqual([]);
  });

  it("stores halal without changing a constraint rule", () => {
    expect(constraintPatchForFlags(["halal"], profile)).toBeNull();
  });

  // D1 §6.1: finishing onboarding always writes the account's constraint_profiles row, even when
  // the chosen chips add no rule to it — the row is what records "this account restricts nothing"
  // now that no default exists in code. halal and vegetarian still add nothing TO the row.
  it.each(["halal", "vegetarian"] as const)(
    "writes the row for %s without adding a rule to it",
    async (flag) => {
      let state = completeState();
      state = { ...state, flags: [flag] };
      const saveLocal = vi.fn();
      const empty = {
        avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
        conditions: [], notes: null,
      };
      const loadConstraints = vi.fn(async () => ({ profile: empty, rev: 0 }));
      const saveConstraints = vi.fn(async () => ({
        status: "ok" as const, profile: empty, rev: 1,
      }));
      const result = await persistCompletedOnboarding(defaultSettings(), state, NOW, {
        saveLocal,
        saveSynced: vi.fn(async () => undefined),
        saveWeighIn: vi.fn(async () => null),
        loadConstraints,
        saveConstraints,
        localDate: () => "2026-09-19",
        hasWeighIn: () => false,
        openFoodWorld: async () => {},
      });

      expect(saveLocal.mock.calls[0][0].dietPrefs.flags).toEqual([flag]);
      expect(saveConstraints).toHaveBeenCalledWith({ baseRev: 0 }, 0);
      expect(result).toMatchObject({ constraintsSaved: true });
      expect(result).not.toHaveProperty("error", CONSTRAINTS_UNAVAILABLE);
    },
  );

  it("saves a mapped constraint once when facet-only and mapped flags are mixed", async () => {
    let state = completeState();
    state = { ...state, flags: ["halal", "no_peanuts"] };
    const saveConstraints = vi.fn(async () => ({
      status: "ok" as const,
      profile: { ...profile, avoid_allergens: [...profile.avoid_allergens, "peanut"] },
      rev: 3,
    }));

    const result = await persistCompletedOnboarding(defaultSettings(), state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => ({ profile, rev: 2 })),
      saveConstraints,
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(saveConstraints).toHaveBeenCalledOnce();
    expect(saveConstraints).toHaveBeenCalledWith({
      baseRev: 2,
      avoidAllergens: ["gluten", "dairy", "apple", "peanut"],
    }, 2);
    expect(result).toMatchObject({ constraintsSaved: true });
  });
});

describe("preference suggestions", () => {
  it("pre-ticks only Jev flags at or above 0.8", () => {
    expect(suggestedPreferenceFlags({ vegetarian: 0.8, vegan: 0.79, no_shellfish: 0.96 }))
      .toEqual(["vegetarian", "no_shellfish"]);
  });

  it("keeps confirmed chip overrides sticky across later Jev passes", () => {
    let state = createOnboardingState(defaultSettings());
    state = onboardingReducer(state, {
      type: "merge_flags",
      flags: suggestedPreferenceFlags({ vegetarian: 0.9, halal: 0.1 }),
    });
    expect(state.flags).toContain("vegetarian");

    state = onboardingReducer(state, { type: "toggle_flag", flag: "vegetarian" });
    state = onboardingReducer(state, {
      type: "merge_flags",
      flags: suggestedPreferenceFlags({ vegetarian: 0.95, halal: 0.1 }),
    });
    expect(state.flags).not.toContain("vegetarian");

    state = onboardingReducer(state, { type: "toggle_flag", flag: "halal" });
    state = onboardingReducer(state, {
      type: "merge_flags",
      flags: suggestedPreferenceFlags({ vegetarian: 0.95, halal: 0.1 }),
    });
    expect(state.flags).toEqual(["halal"]);
    expect(state.userOverrides).toEqual({ vegetarian: false, halal: true });
  });

  it("discards an older overlapping Jev response that settles last", async () => {
    const resolvers: ((value: PrefsResponse | null) => void)[] = [];
    const classify = vi.fn(() => new Promise<PrefsResponse | null>((resolve) => {
      resolvers.push(resolve);
    }));
    const applied: string[][] = [];
    const busy: boolean[] = [];
    const classifier = createPreferenceClassifier(
      (flags) => applied.push(flags),
      (value) => busy.push(value),
      classify,
    );

    const older = classifier.run("vegetarian");
    const newer = classifier.run("halal");
    resolvers[1]({ flags: { halal: 0.95 }, mentionsFoods: 0, jev: true });
    await newer;
    resolvers[0]({ flags: { vegetarian: 0.95 }, mentionsFoods: 0, jev: true });
    await older;

    expect(applied).toEqual([["halal"]]);
    expect(busy).toEqual([true, true, false]);
    expect(isNextDisabled(3, false, true, true)).toBe(true);
    expect(isNextDisabled(2, false, true, true)).toBe(false);
  });

  it("keeps the current chips for the real Jev-down response shape", async () => {
    let state: OnboardingState = { ...createOnboardingState(defaultSettings()),
      flags: ["vegetarian", "halal"],
      userOverrides: { halal: true } };
    const before = state;
    const classifier = createPreferenceClassifier(
      (flags) => { state = onboardingReducer(state, { type: "merge_flags", flags }); },
      vi.fn(),
      async () => ({ flags: {}, mentionsFoods: 0, jev: false }),
    );
    // Text the safety check sends (kept text never makes a request: tests/profile/local-diet-flags.test.ts).
    await classifier.run("I love Italian food");
    expect(state).toEqual(before);
  });

  it("keeps the current chips when the preference request has a network error", async () => {
    let state: OnboardingState = { ...createOnboardingState(defaultSettings()), flags: ["halal"],
      userOverrides: { halal: true } };
    const before = state;
    const classifier = createPreferenceClassifier(
      (flags) => { state = onboardingReducer(state, { type: "merge_flags", flags }); },
      vi.fn(),
      (text) => classifyDietaryPreferences(text, {
        fetchImpl: vi.fn(async () => { throw new Error("offline"); }),
      }),
    );
    // Text the safety check sends (kept text never makes a request: tests/profile/local-diet-flags.test.ts).
    await classifier.run("I love Italian food");
    expect(state).toEqual(before);
  });
});

describe("the five onboarding steps", () => {
  it("renders all policy preferences and omits the old advisory group", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesStep, {
      state: createOnboardingState(defaultSettings()),
      dispatch: () => {},
      onBlur: () => {},
      classifying: false,
    }));
    const enforcedStart = markup.indexOf("Enforced exclusions");

    expect(enforcedStart).toBeGreaterThanOrEqual(0);
    expect(markup).not.toContain("Preferences for coach suggestions");
    for (const label of [
      "Vegetarian", "Vegan", "Pescatarian", "No pork", "No beef", "No shellfish",
      "No eggs", "No soy", "No peanuts", "Low FODMAP", "Halal", "Kosher",
    ]) {
      expect(markup.slice(enforcedStart)).toContain(label);
    }
  });

  it("shows the exact policy copy and a cooking suggestion that is not confirmed", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesStep, {
      state: createOnboardingState(defaultSettings()),
      dispatch: () => {}, onBlur: () => {}, classifying: false,
      cookingEffort: null, cookingEffortSuggestion: "minimal",
    }));

    expect(markup).toContain(PREFERENCE_POLICY_COPY);
    expect(markup).toContain("Minimal cooking · Suggested");
    expect(markup).toMatch(/aria-pressed="false"[^>]*>Minimal cooking · Suggested/);
  });

  it("marks cooking effort active only after the user confirms its chip", () => {
    const props = {
      state: createOnboardingState(defaultSettings()), dispatch: () => {},
      onBlur: () => {}, classifying: false, cookingEffortSuggestion: "minimal" as const,
    };
    const selected = toggleCookingEffort(null, "minimal");
    const confirmed = renderToStaticMarkup(createElement(PreferencesStep, {
      ...props, cookingEffort: selected,
    }));

    expect(selected).toBe("minimal");
    expect(toggleCookingEffort(selected, "minimal")).toBeNull();
    expect(confirmed).toMatch(/aria-pressed="true"[^>]*>Minimal cooking/);
    expect(confirmed).not.toContain("Minimal cooking · Suggested");
  });

  it("moves body, activity, goal, preferences, and plan data through the reducer", () => {
    let state = createOnboardingState(defaultSettings());
    const dispatch = (action: Parameters<typeof onboardingReducer>[1]) => {
      state = onboardingReducer(state, action);
    };

    dispatch({ type: "set_weight_unit", value: "lb" });
    dispatch({ type: "edit_weight", value: "132.277" });
    dispatch({ type: "edit_body", key: "heightCm", value: "165" });
    dispatch({ type: "edit_body", key: "birthYear", value: "1996" });
    dispatch({ type: "set_sex", value: "female" });
    expect(renderToStaticMarkup(createElement(BodyStep, { state, dispatch })))
      .toContain(`Age today: ${new Date().getFullYear() - 1996}`);
    const body = renderToStaticMarkup(createElement(BodyStep, { state, dispatch }));
    expect(body).toContain("Feet and inches");
    expect(body).toContain("Weight in pounds");

    // D1 §6.3: no weekday is preselected. An empty list is an explicit rest-only schedule.
    expect(state.trainingWeekdays).toEqual([]);
    dispatch({ type: "toggle_weekday", value: 3 });
    dispatch({ type: "toggle_weekday", value: 2 });
    dispatch({ type: "set_activity", value: "moderate" });
    const activity = renderToStaticMarkup(createElement(ActivityStep, { state, dispatch }));
    expect(activity).toContain("Training days");
    expect(state.trainingWeekdays).toEqual([2, 3]);

    dispatch({ type: "set_goal", value: "maintain" });
    const goal = renderToStaticMarkup(createElement(GoalStep, { state, dispatch }));
    expect(goal).toMatch(/aria-pressed="true"[^>]*>[\s\S]*Maintain/);
    expect(state.goal).toBe("maintain");

    dispatch({ type: "merge_flags", flags: ["vegetarian", "no_shellfish"] });
    dispatch({ type: "toggle_flag", flag: "vegetarian" });
    dispatch({ type: "merge_flags", flags: ["vegetarian"] });
    const preferences = renderToStaticMarkup(createElement(PreferencesStep, {
      state, dispatch, onBlur: () => {}, classifying: false,
    }));
    expect(preferences).toContain("Vegetarian");
    expect(preferences).toContain("Enforced exclusions");
    expect(preferences).not.toContain("Preferences for coach suggestions");
    expect(state.flags).not.toContain("vegetarian");

    const derived = buildCompletedSettings(defaultSettings(), state, NOW);
    const plan = renderToStaticMarkup(createElement(PlanStep, {
      state, base: defaultSettings(), dispatch,
    }));
    expect(plan).toContain(`${derived.activeTargetProfile!.training.kcal.toLocaleString()} kcal`);
    expect(plan).toContain("Reset to derived");
    expect(derived.weightKg).toBeCloseTo(60, 3);

    dispatch({ type: "edit_plan", field: "trainingKcal", value: 2300 });
    dispatch({ type: "edit_plan", field: "proteinG", value: 135 });
    const edited = buildCompletedSettings(defaultSettings(), state, NOW);
    expect(edited.trainingKcal).toBe(2300);
    expect(edited.restKcal).toBeNull();
    expect(edited.proteinG).toBe(135);
    expect(edited.activeTargetProfile).toEqual(derived.activeTargetProfile);

    dispatch({ type: "reset_plan" });
    const reset = buildCompletedSettings(defaultSettings(), state, NOW);
    expect(state.planEdits).toEqual({ trainingKcal: null, restKcal: null, proteinG: null });
    expect(reset).toMatchObject({ trainingKcal: null, restKcal: null, proteinG: null });
  });

  it("leaves existing pins untouched when the derived defaults were not edited", () => {
    const state = completeState();
    const base = { ...defaultSettings(), trainingKcal: 2400, restKcal: 1900, proteinG: 140 };
    const settings = buildCompletedSettings(base, state, NOW);
    expect(settings).toMatchObject({ trainingKcal: 2400, restKcal: 1900, proteinG: 140 });
  });

  it("resetting clears existing pins back to the derived plan", () => {
    let state = completeState();
    state = onboardingReducer(state, { type: "reset_plan" });
    const base = { ...defaultSettings(), trainingKcal: 2400, restKcal: 1900, proteinG: 140 };
    const settings = buildCompletedSettings(base, state, NOW);
    expect(settings).toMatchObject({ trainingKcal: null, restKcal: null, proteinG: null });
  });
});

describe("constraint save failures", () => {
  it("returns constraints_unavailable and shows the warning when rules cannot load", async () => {
    const saveConstraints = vi.fn();
    const result = await persistCompletedOnboarding(defaultSettings(), completeState(), NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => null),
      saveConstraints,
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(saveConstraints).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      constraintsSaved: false,
      error: CONSTRAINTS_UNAVAILABLE,
    });
    expect(renderToStaticMarkup(createElement(OnboardingNotice, {
      message: CONSTRAINT_SAVE_WARNING,
    }))).toContain(CONSTRAINT_SAVE_WARNING);
  });

  // Every chosen rule is already in the row, so the patch is empty — and the PUT still goes, to
  // prove the row exists at the rev this device read (D1 §6.1).
  it("still writes the row when the chosen rules are all already in it", async () => {
    const profile = {
      avoid_allergens: ["gluten", "dairy", "apple", "shellfish"],
      avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null,
    };
    const saveConstraints = vi.fn(async () => ({ status: "ok" as const, profile, rev: 5 }));
    const result = await persistCompletedOnboarding(defaultSettings(), completeState(), NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => ({ profile, rev: 4 })),
      saveConstraints,
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(saveConstraints).toHaveBeenCalledWith({ baseRev: 4 }, 4);
    expect(result).toMatchObject({ constraintsSaved: true });
  });

  it("completes onboarding and returns a visible warning after a 500 PUT", async () => {
    const state = completeState();
    const result = await persistCompletedOnboarding(defaultSettings(), state, NOW, {
      saveLocal: vi.fn(),
      saveSynced: vi.fn(async () => undefined),
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => ({
        rev: 4,
        profile: {
          avoid_allergens: ["gluten", "dairy", "apple"],
          avoid_food_ref_ids: [],
          banned_categories: [],
          conditions: [],
          notes: null,
        },
      })),
      saveConstraints: (patch, rev) => putConstraints(patch, rev, {
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })),
      }),
      localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });

    expect(result.constraintsSaved).toBe(false);
    expect(result.error).toBe(CONSTRAINTS_UNAVAILABLE);
    expect(renderToStaticMarkup(createElement(OnboardingNotice, {
      message: CONSTRAINT_SAVE_WARNING,
    }))).toContain(CONSTRAINT_SAVE_WARNING);
  });

  it("returns the warning when a rev conflict remains after one retry", async () => {
    const state = completeState();
    const profile = {
      avoid_allergens: ["gluten", "dairy", "apple"],
      avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null,
    };
    const saveConstraints = vi.fn(async () => ({ status: "conflict" as const, profile, rev: 5 }));
    const result = await persistCompletedOnboarding(defaultSettings(), state, NOW, {
      saveLocal: vi.fn(), saveSynced: vi.fn(async () => undefined),
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => ({ profile, rev: 4 })),
      saveConstraints, localDate: () => "2026-09-19",
      hasWeighIn: () => false,
      openFoodWorld: async () => {},
    });
    expect(saveConstraints).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ constraintsSaved: false, error: CONSTRAINTS_UNAVAILABLE });
  });
});

describe("OnboardingFlow", () => {
  it("keeps the body-step Next disabled until the required body fields are valid", () => {
    const incomplete = createOnboardingState(defaultSettings());
    expect(isBodyStepComplete(incomplete)).toBe(false);
    expect(isNextDisabled(0, false, false, isBodyStepComplete(incomplete))).toBe(true);

    const complete = completeState();
    expect(isBodyStepComplete(complete)).toBe(true);
    expect(isNextDisabled(0, false, false, isBodyStepComplete(complete))).toBe(false);
  });

  /** The attributes of the system button whose label is `label` (components/ui/Button markup). */
  const buttonAttributes = (markup: string, label: string) =>
    new RegExp(`<button([^>]*)><span class="btn-stack"><span class="btn-label">${label}</span>`).exec(markup)?.[1] ?? "";

  it.each([
    [0, "Next"],
    [5, "Use this plan"],
  ])("keeps the disabled %s primary action the system primary", (initial, label) => {
    const markup = renderToStaticMarkup(createElement(OnboardingFlow, {
      initial,
      initialSettings: defaultSettings(),
    }));
    // The olive primary; disabled, it fades to the system's 40 % and keeps its size (DESIGN.md §Buttons).
    const attributes = buttonAttributes(markup, label);
    expect(attributes).toMatch(/class="[^"]*\bbtn-primary\b[^"]*"/);
    expect(attributes).not.toMatch(/bg-white/);
    expect(attributes).toMatch(/disabled=""/);
  });

  it("uses the same primary-action class on the Next and final footers", () => {
    const primaryClass = (initial: number, label: string) => {
      const markup = renderToStaticMarkup(createElement(OnboardingFlow, {
        initial, initialSettings: defaultSettings(),
      }));
      return /class="([^"]*)"/.exec(buttonAttributes(markup, label))?.[1].split(/\s+/)
        .filter((token) => token.startsWith("btn")).join(" ");
    };

    expect(primaryClass(0, "Next")).toBe("btn btn-primary btn-md");
    expect(primaryClass(0, "Next")).toBe(primaryClass(5, "Use this plan"));
  });

  it("renders the plan step and names incomplete fields", () => {
    const markup = renderToStaticMarkup(createElement(OnboardingFlow, {
      initial: 5,
      initialSettings: defaultSettings(),
    }));

    expect(markup).toContain("Your plan");
    expect(markup).toContain("birth year");
    expect(markup).toContain("activity level");
    expect(markup).toContain("Skip for now");
  });

  it("loads the legacy no_nuts flag as no_peanuts and shows the renamed chip", () => {
    const settings = {
      ...defaultSettings(),
      dietPrefs: { text: "No nuts", flags: ["no_nuts"] },
    };
    const state = createOnboardingState(settings);
    const markup = renderToStaticMarkup(createElement(PreferencesStep, {
      state, dispatch: () => {}, onBlur: () => {}, classifying: false,
    }));

    expect(state.flags).toContain("no_peanuts");
    expect(state.flags).not.toContain("no_nuts");
    expect(markup).toContain("No peanuts");
    expect(markup).not.toContain(">No nuts</button>");
  });
});

describe("body-fat source on the Body step (step C)", () => {
  const complete = (state: OnboardingState): OnboardingState => [
    { type: "edit_body", key: "heightCm", value: "170" },
    { type: "edit_body", key: "birthYear", value: "1968" },
    { type: "set_sex", value: "female" },
    { type: "edit_weight", value: "160" },
    { type: "set_activity", value: "moderate" },
    { type: "set_goal", value: "recomp" },
  ].reduce((s, a) => onboardingReducer(s, a as never), state);

  it("carries a picked scan into the completed settings", () => {
    let state = complete(createOnboardingState(defaultSettings()));
    state = onboardingReducer(state, { type: "edit_body", key: "bodyFatPct", value: "32" });
    state = onboardingReducer(state, { type: "set_body_fat_source", source: "dexa",
      measuredOn: "2026-09-01" });
    const settings = buildCompletedSettings(defaultSettings(), state,
      new Date("2026-09-22T18:00:00Z"));
    expect(settings).toMatchObject({ bodyFatPct: 32, bodyFatSource: "dexa",
      bodyFatMeasuredOn: "2026-09-01" });
  });

  it("drops the source when the number changes after it was picked", () => {
    let state = complete(createOnboardingState(defaultSettings()));
    state = onboardingReducer(state, { type: "edit_body", key: "bodyFatPct", value: "32" });
    state = onboardingReducer(state, { type: "set_body_fat_source", source: "inbody",
      measuredOn: "2026-09-01" });
    state = onboardingReducer(state, { type: "edit_body", key: "bodyFatPct", value: "30" });
    expect(state).toMatchObject({ bodyFatSource: null, bodyFatMeasuredOn: null });
  });

  it("stores no source when there is no body fat", () => {
    let state = complete(createOnboardingState(defaultSettings()));
    state = onboardingReducer(state, { type: "set_body_fat_source", source: "dexa",
      measuredOn: "2026-09-01" });
    const settings = buildCompletedSettings(defaultSettings(), state,
      new Date("2026-09-22T18:00:00Z"));
    expect(settings).toMatchObject({ bodyFatPct: null, bodyFatSource: null,
      bodyFatMeasuredOn: null });
  });
});
