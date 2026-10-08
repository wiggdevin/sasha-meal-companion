import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { PreferencesStep } from "@/components/Onboarding/OnboardingSteps";
import { persistCompletedOnboarding } from "@/lib/profile/onboarding-client";
import {
  advisoryFlags,
  createOnboardingState,
  enforcedFlags,
} from "@/lib/profile/onboarding-state";
import { suggestedPreferenceFlags } from "@/lib/profile/prefs-client";
import { defaultSettings } from "@/lib/store";
import {
  cookingEffortFromDietPrefs, settingsProfileFromRow, settingsProfileToRow,
  settingsWithCookingEffort,
} from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";

const NOW = new Date("2026-09-20T12:00:00.000Z");

beforeEach(async () => {
  await resetTestAccount();
});

function completeLegacyState() {
  const state = createOnboardingState({
    ...defaultSettings(),
    sex: "female",
    birthYear: 1996,
    heightCm: 165,
    weightKg: 60,
    activityLevel: "moderate",
    goal: "recomp",
    trainingWeekdays: [1, 3, 4, 5],
    dietPrefs: { text: "No nuts", flags: ["no_nuts"] },
  });
  return state;
}

describe("peanut preference normalization", () => {
  it("stores no_peanuts after the settings flow saves a legacy no_nuts value", async () => {
    const savedLocally: Settings[] = [];
    const savedForSync: Settings[] = [];
    const saveLocal = vi.fn((settings: Settings) => { savedLocally.push(settings); });
    const saveSynced = vi.fn(async (settings: Settings) => {
      savedForSync.push(settings);
      return undefined;
    });

    await persistCompletedOnboarding(defaultSettings(), completeLegacyState(), NOW, {
      saveLocal,
      saveSynced,
      saveWeighIn: vi.fn(async () => null),
      loadConstraints: vi.fn(async () => null),
      saveConstraints: vi.fn(),
      localDate: () => "2026-09-20",
      hasWeighIn: () => true,
      openFoodWorld: async () => {},
    });

    expect(savedForSync[0]?.dietPrefs?.flags).toEqual(["no_peanuts"]);
    expect(savedLocally[0]?.dietPrefs?.flags).toEqual(["no_peanuts"]);
  });

  it("labels the normalized option no peanuts", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesStep, {
      state: completeLegacyState(),
      dispatch: () => {},
      onBlur: () => {},
      classifying: false,
    }));

    expect(markup).toContain("No peanuts");
    expect(markup).not.toContain(">No nuts</button>");
  });

  it("normalizes a legacy classifier key and never emits no_nuts", () => {
    const flags = suggestedPreferenceFlags({ no_nuts: 0.99 });
    expect(flags).toEqual(["no_peanuts"]);
    expect(flags).not.toContain("no_nuts");
  });

  it("uses no_peanuts in both preference group outputs", () => {
    expect(enforcedFlags()).toContain("no_peanuts");
    expect(enforcedFlags()).not.toContain("no_nuts");
    expect(advisoryFlags()).not.toContain("no_nuts");
  });
});

describe("cooking effort lifestyle", () => {
  it("round-trips a confirmed value through the existing diet_prefs JSON", () => {
    const settings = settingsWithCookingEffort(defaultSettings(), "minimal");
    const row = settingsProfileToRow(settings);

    expect(row.diet_prefs).toEqual({
      flags: [], lifestyle: { cookingEffort: "minimal" },
    });
    expect(settingsProfileFromRow(row).dietPrefs).toEqual(row.diet_prefs);
    expect(cookingEffortFromDietPrefs(row.diet_prefs)).toBe("minimal");
  });

  it("drops unknown stored values instead of guessing a cooking effort", () => {
    const profile = settingsProfileFromRow({
      diet_prefs: { flags: [], lifestyle: { cookingEffort: "sometimes" } } as never,
    });

    expect(profile.dietPrefs).toEqual({ flags: [] });
    expect(cookingEffortFromDietPrefs(profile.dietPrefs)).toBeNull();
  });
});
