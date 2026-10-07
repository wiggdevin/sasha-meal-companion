import { describe, expect, it } from "vitest";
import { applyDerivedProfile, resolveTargets } from "./targets";
import { defaultSettings } from "./store";

describe("target revision authority", () => {
  it("returns no targets when the server revision cache is missing", () => {
    expect(resolveTargets("rest", defaultSettings())).toBeNull();
  });

  it("uses the effective revision without deriving or applying local pins", () => {
    const settings = {
      ...defaultSettings(),
      trainingKcal: 999,
      activeTargetProfile: {
        revision: 4,
        training: { kcal: 2100, protein: 130, carbs: 220, fat: 78 },
        rest: { kcal: 1800, protein: 130, carbs: 150, fat: 76 },
        pins: { trainingKcal: null, restKcal: null, proteinG: null },
      },
    };
    expect(resolveTargets("training-10", settings)).toEqual({
      macros: settings.activeTargetProfile.training,
      pinned: false,
    });
  });

  it("derives a preview only when explicitly called with a complete profile", () => {
    const settings = {
      ...defaultSettings(),
      sex: "female" as const,
      birthYear: 1990,
      heightCm: 168,
      weightKg: 62,
      activityLevel: "moderate" as const,
      goal: "recomp" as const,
      trainingWeekdays: [],
    };
    const next = applyDerivedProfile(settings, new Date("2026-09-20T12:00:00Z"));
    expect(next.activeTargetProfile?.inputs?.trainingWeekdays).toEqual([]);
    // Design §5.4: the preview is not a target, so it carries no revision for the
    // phone to read; `/api/targets` assigns the number the cache then holds.
    expect(next.activeTargetProfile?.revision).toBeUndefined();
    // ...and so the phone resolves no target from the preview alone.
    expect(resolveTargets("training-10", next)).toBeNull();
  });
});
