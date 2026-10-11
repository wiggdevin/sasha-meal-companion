// W007 (audit 2026-10-10 A002): a pinned day is never written under the revision's own recorded
// floors. `adjustCalories` used to leave a rest-day pin at the older 80 g carb floor, while the
// same revision recorded carbGMin 100 and kcalMin 4·protein + 450 + 400.
import { describe, expect, it } from "vitest";
import { deriveTargetRevision } from "@/lib/profile/derive";
import { defaultSettings } from "@/lib/store";
import type { Macros, Settings } from "@/lib/types";

function settings(over: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), sex: "female", birthYear: 1968, heightCm: 170, weightKg: 72.6,
    activityLevel: "moderate", goal: "recomp", trainingWeekdays: [1, 3, 4, 5], ...over };
}

const derive = (over: Partial<Settings>) => deriveTargetRevision({ settings: settings(over),
  latestWeighInKg: null, today: "2026-10-10", trainingWeekdays: [1, 3, 4, 5] });

function expectWithinFloors(day: Macros, floors: ReturnType<typeof derive>["floors"]) {
  expect(day.carbs).toBeGreaterThanOrEqual(floors.carbGMin);
  expect(day.fat).toBeGreaterThanOrEqual(floors.fatGMin);
  expect(day.protein).toBeGreaterThanOrEqual(floors.proteinGMin);
  expect(day.kcal).toBeGreaterThanOrEqual(floors.kcalMin);
  expect(day.kcal).toBe(4 * day.protein + 4 * day.carbs + 9 * day.fat);
}

describe("pinned days and the revision's own floors", () => {
  it("raises a 900 kcal rest-day pin to the 100 g carb floor and the kcal minimum", () => {
    const revision = derive({ restKcal: 900 });
    expect(revision.rest).toEqual({ protein: 145, carbs: 100, fat: 50, kcal: 1430 });
    expect(revision.floors).toMatchObject({ kcalMin: 1430, carbGMin: 100, proteinGMin: 145 });
    expectWithinFloors(revision.rest, revision.floors);
    expectWithinFloors(revision.training, revision.floors);
  });

  it("records the minimum from a pinned protein, so the pinned day is within it", () => {
    const revision = derive({ proteinG: 100, restKcal: 1000, trainingKcal: 1000 });
    expect(revision.floors).toMatchObject({ proteinGMin: 100, kcalMin: 4 * 100 + 450 + 400 });
    expectWithinFloors(revision.rest, revision.floors);
    expectWithinFloors(revision.training, revision.floors);
  });

  it("changes nothing without a pin", () => {
    const revision = derive({});
    expect(revision.floors.kcalMin).toBe(4 * revision.training.protein + 450 + 400);
    expectWithinFloors(revision.rest, revision.floors);
  });
});
