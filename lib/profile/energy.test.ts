import { describe, expect, it } from "vitest";
import { defaultSettings } from "../store";
import type { ActivityLevel, Goal } from "../types";
import { deriveTargetRevision } from "./derive";
import {
  activityFactor,
  bmr,
  katchEligible,
  deriveTargets,
  energyProfileFrom,
  isProfileComplete,
  weightForTargets,
  type EnergyProfile,
} from "./energy";
import { DEFAULT_RATE_BP } from "./rate-goal";

const TODAY = new Date(2026, 8, 19);

function profile(overrides: Partial<EnergyProfile> = {}): EnergyProfile {
  const goal = overrides.goal ?? "maintain";
  return {
    sex: "female",
    birthYear: 1996,
    heightCm: 165,
    weightKg: 60,
    bodyFatPct: null,
    activityLevel: "moderate",
    goal,
    goalRateBpWeek: DEFAULT_RATE_BP[goal],
    ...overrides,
  };
}

const identity = (day: { protein: number; carbs: number; fat: number; kcal: number }) =>
  expect(day.kcal).toBe(4 * day.protein + 4 * day.carbs + 9 * day.fat);

describe("bmr", () => {
  it("uses Mifflin-St Jeor for a 30-year-old woman without body-fat data", () => {
    expect(bmr(profile(), TODAY)).toBe(1320.25);
  });

  it("uses the male Mifflin-St Jeor adjustment", () => {
    expect(bmr(profile({ sex: "male", heightCm: 180, weightKg: 80 }), TODAY)).toBe(1780);
  });

  it("computes the formula's 25-year-old male value from birth year", () => {
    expect(bmr(profile({ sex: "male", birthYear: 2001, heightCm: 180, weightKg: 80 }), TODAY))
      .toBe(1805);
  });

  it("uses Katch-McArdle for a recent measured body-fat value", () => {
    // Made-up inputs: 60 kg at 25% body fat is 45 kg lean mass; 370 + 21.6 × 45 = 1342.
    expect(bmr(profile({ weightKg: 60, bodyFatPct: 25, bodyFatSource: "inbody",
      bodyFatMeasuredOn: "2026-08-01" }), TODAY)).toBeCloseTo(1342, 0);
  });

  // Onboarding v2 "prefer not to say" (coordinator ruling 2026-10-06): the midpoint sex term is
  // exactly (5 + -161) / 2 = -78, and it must never change an existing male or female result.
  describe("sex: 'unspecified' (prefer not to say)", () => {
    it("uses the exact midpoint of the male (+5) and female (-161) terms", () => {
      const male = bmr(profile({ sex: "male", heightCm: 180, weightKg: 80 }), TODAY);
      const female = bmr(profile({ sex: "female", heightCm: 180, weightKg: 80 }), TODAY);
      const unspecified = bmr(profile({ sex: "unspecified", heightCm: 180, weightKg: 80 }), TODAY);
      expect(unspecified).toBe((male + female) / 2);
      expect(male - unspecified).toBe(unspecified - female);
      expect(male - unspecified).toBe(83); // (5 - -78) = 83 = (-78 - -161)
    });

    it("never changes the male or female result by a single kcal", () => {
      expect(bmr(profile({ sex: "male", heightCm: 180, weightKg: 80 }), TODAY)).toBe(1780);
      expect(bmr(profile(), TODAY)).toBe(1320.25);
    });

    it("needs no sex term at all for Katch-McArdle (body fat known)", () => {
      const base = { weightKg: 60, bodyFatPct: 25, bodyFatSource: "inbody" as const,
        bodyFatMeasuredOn: "2026-08-01" };
      expect(bmr(profile({ ...base, sex: "unspecified" }), TODAY))
        .toBe(bmr(profile({ ...base, sex: "female" }), TODAY));
    });

    it("is a complete profile, same as female or male", () => {
      const settings = { ...defaultSettings(), sex: "unspecified" as const, birthYear: 1996,
        heightCm: 165, weightKg: 60, activityLevel: "moderate" as const, goal: "maintain" as const };
      expect(isProfileComplete(settings)).toBe(true);
    });
  });
});

describe("body-fat provenance (step C)", () => {
  // Pinned here, at noon UTC like every production caller, so the 180-day edges below do not
  // depend on the file-level TODAY or on the time zone the suite runs in.
  const TODAY = new Date("2026-09-19T12:00:00Z");
  const measured = (over: Partial<EnergyProfile>) =>
    profile({ weightKg: 60, bodyFatPct: 25, ...over });
  const MIFFLIN = bmr(profile({ weightKg: 60 }), TODAY);

  it("accepts a scan taken today", () => {
    expect(katchEligible({ bodyFatPct: 25, bodyFatSource: "dexa",
      bodyFatMeasuredOn: "2026-09-19" }, TODAY)).toBe(true);
  });

  it("uses Mifflin-St Jeor in bmr itself for a stale or malformed scan", () => {
    for (const bodyFatMeasuredOn of ["2026-03-22", "2026-02-30", "2026-09-20"]) {
      expect(bmr(measured({ bodyFatSource: "inbody", bodyFatMeasuredOn }), TODAY)).toBe(MIFFLIN);
    }
  });

  it("uses Mifflin-St Jeor for a typed value with no source", () => {
    expect(bmr(measured({}), TODAY)).toBe(MIFFLIN);
  });

  it.each(["consumer_scale", "visual_estimate", "typed_unknown"] as const)(
    "uses Mifflin-St Jeor for an unmeasured source: %s", (bodyFatSource) => {
      expect(bmr(measured({ bodyFatSource, bodyFatMeasuredOn: "2026-09-01" }), TODAY))
        .toBe(MIFFLIN);
    });

  it.each(["dexa", "inbody", "clinical_bia"] as const)(
    "uses Katch-McArdle for a measured source within 180 days: %s", (bodyFatSource) => {
      expect(katchEligible({ bodyFatPct: 25, bodyFatSource, bodyFatMeasuredOn: "2026-03-23" },
        TODAY)).toBe(true);
    });

  it("falls back to Mifflin-St Jeor once the measurement is older than 180 days", () => {
    expect(katchEligible({ bodyFatPct: 25, bodyFatSource: "dexa",
      bodyFatMeasuredOn: "2026-03-22" }, TODAY)).toBe(false);
  });

  it("refuses a measured source with no date, a future date, or a malformed date", () => {
    for (const bodyFatMeasuredOn of [null, undefined, "2026-09-20", "2026-13-01", "2026-02-30",
      "2026-9-1", "soon"]) {
      expect(katchEligible({ bodyFatPct: 25, bodyFatSource: "inbody", bodyFatMeasuredOn },
        TODAY)).toBe(false);
    }
  });

  it("never uses Katch-McArdle without a body-fat value", () => {
    expect(katchEligible({ bodyFatPct: null, bodyFatSource: "dexa",
      bodyFatMeasuredOn: "2026-09-01" }, TODAY)).toBe(false);
  });
});

describe("energy coefficients", () => {
  it.each<[ActivityLevel, number]>([
    ["sedentary", 1.2],
    ["light", 1.3],
    ["moderate", 1.4],
    ["active", 1.55],
    ["very_active", 1.7],
  ])("maps %s activity to %s", (level, expected) => {
    expect(activityFactor(level)).toBe(expected);
  });
});

describe("deriveTargets", () => {
  it.each<[Goal, number]>([
    ["lose_fat", 120],
    ["recomp", 120],
    ["maintain", 108],
    ["gain_muscle", 108],
  ])("derives protein from weight for %s", (goal, expected) => {
    const targets = deriveTargets(profile({ goal }), TODAY, 4);
    expect(targets.training.protein).toBe(expected);
    expect(targets.rest.protein).toBe(expected);
  });

  it("caps the protein basis at BMI 30: 170 cm, 100 kg, losing → 86.7 kg → 173 g", () => {
    const targets = deriveTargets(profile({ heightCm: 170, weightKg: 100, goal: "lose_fat" }),
      TODAY, 4);
    expect(targets.training.protein).toBe(173);
  });

  it("gives the same protein whether the body fat is a scan or a guess", () => {
    const scan = deriveTargets(profile({ bodyFatPct: 30, bodyFatSource: "dexa",
      bodyFatMeasuredOn: "2026-09-01", goal: "lose_fat" }), new Date("2026-09-19T12:00:00Z"), 4);
    const typed = deriveTargets(profile({ bodyFatPct: 30, goal: "lose_fat" }),
      new Date("2026-09-19T12:00:00Z"), 4);
    expect(scan.training.protein).toBe(typed.training.protein);
  });

  it("refuses a rate that does not belong to the goal", () => {
    expect(() => deriveTargets(profile({ goal: "maintain", goalRateBpWeek: -50 }), TODAY, 4))
      .toThrow(/rate/);
    expect(() => deriveTargets(profile({ goal: "lose_fat", goalRateBpWeek: 20 }), TODAY, 4))
      .toThrow(/rate/);
    // 0 is "not confirmed yet" for any goal and derives at maintenance.
    expect(deriveTargets(profile({ goal: "lose_fat", goalRateBpWeek: 0 }), TODAY, 4).rate)
      .toMatchObject({ bound: null, effectiveRatePctWeek: 0 });
  });

  it("keeps fat at the 50 g floor on a low-calorie profile", () => {
    const targets = deriveTargets(profile({ weightKg: 40, heightCm: 140,
      activityLevel: "sedentary", goal: "lose_fat" }), TODAY, 4);
    expect(targets.training.fat).toBe(50);
    expect(targets.rest.fat).toBe(50);
  });

  it("raises a small profile to its own macro minimum, never to a 1,200 kcal sex floor", () => {
    // Female, 30 y, 140 cm, 40 kg, sedentary: Mifflin 964 × 1.2 = 1,157; −75 bp is capped at
    // −20 % → 926, below the macro minimum 4·80 + 9·50 + 4·100 = 1,170, which wins.
    const targets = deriveTargets(profile({ weightKg: 40, heightCm: 140,
      activityLevel: "sedentary", goal: "lose_fat", goalRateBpWeek: -75 }), TODAY, 4);
    expect(targets.rate).toMatchObject({ tdeeKcal: 1157, kcalMin: 1170, targetKcal: 1170,
      bound: "kcal_min" });
    expect(targets.training).toEqual({ protein: 80, carbs: 110, fat: 50, kcal: 1210 });
    expect(targets.rest).toEqual({ protein: 80, carbs: 100, fat: 50, kcal: 1170 });
    expect(targets.floorsBound).toEqual(["training:fat", "training:kcal", "rest:fat",
      "rest:carbs", "rest:kcal"]);
  });

  it("keeps a cycled rest day at 100 g carbs and reports the floor", () => {
    // 60 kg maintain: 239 g base carbs; six training days leave the rest day 239 × 0.4 = 96 g.
    const targets = deriveTargets(profile(), TODAY, 6);
    expect(targets.rest.carbs).toBe(100);
    expect(targets.training.carbs).toBe(263);
    expect(targets.floorsBound).toEqual(["rest:carbs"]);
    identity(targets.training);
    identity(targets.rest);
  });

  it("does not report the carb floor when 99.6 g rounds to the stored 100 g", () => {
    // This profile has a 249 g base; a six-day cycle makes rest exactly 249 × 0.4 = 99.6 g.
    const targets = deriveTargets(profile({ weightKg: 50.5, heightCm: 210,
      activityLevel: "sedentary" }), TODAY, 6);

    expect(targets.rest.carbs).toBe(100);
    expect(targets.floorsBound).not.toContain("rest:carbs");
  });

  it("cycles a 4/3 week around the base and preserves the Atwater identity each day", () => {
    const targets = deriveTargets(profile(), TODAY, 4);
    const averageKcal = (4 * targets.training.kcal + 3 * targets.rest.kcal) / 7;
    const baseKcal = Math.round(bmr(profile(), TODAY) * activityFactor("moderate"));

    expect(Math.abs(averageKcal - baseKcal)).toBeLessThanOrEqual(1);
    expect(targets.training.carbs).toBeGreaterThan(targets.rest.carbs);
    // Rest days carry 1 − 0.1 × 4/3 of the weekly-mean carbs when 4 of 7 days train.
    const meanCarbs = (4 * targets.training.carbs + 3 * targets.rest.carbs) / 7;
    expect(targets.rest.carbs / meanCarbs).toBeCloseTo(0.8667, 2);
    for (const day of [targets.training, targets.rest]) {
      identity(day);
      expect(Number.isInteger(day.protein)).toBe(true);
      expect(Number.isInteger(day.carbs)).toBe(true);
      expect(Number.isInteger(day.fat)).toBe(true);
    }
  });

  const goals: Goal[] = ["lose_fat", "recomp", "maintain", "gain_muscle"];
  const matrix = (["floor-bound", "no-floor"] as const).flatMap((kind) =>
    goals.flatMap((goal) => Array.from({ length: 8 }, (_, trainingDays) =>
      ({ kind, goal, trainingDays }))));

  it.each(matrix)(
    "$kind profile, $goal, $trainingDays training days satisfies cycling and floors",
    ({ kind, goal, trainingDays }) => {
      const input = kind === "floor-bound"
        ? profile({ sex: "female", weightKg: 40, heightCm: 140,
          activityLevel: "sedentary", goal })
        : profile({ sex: "male", birthYear: 1990, weightKg: 100, heightCm: 190,
          activityLevel: "active", goal });
      const targets = deriveTargets(input, TODAY, trainingDays);
      const { rate } = targets;

      for (const day of [targets.training, targets.rest]) {
        identity(day);
        expect(day.kcal).toBeGreaterThanOrEqual(rate.kcalMin);
        expect(day.carbs).toBeGreaterThanOrEqual(100);
        expect(day.fat).toBeGreaterThanOrEqual(50);
      }
      expect(targets.training.protein).toBe(targets.rest.protein);
      // The rate never breaks the TDEE cap in either direction.
      expect(rate.targetKcal).toBeGreaterThanOrEqual(Math.max(rate.kcalMin,
        Math.round(rate.tdeeKcal * 0.8)));
      expect(rate.targetKcal).toBeLessThanOrEqual(Math.max(rate.kcalMin,
        Math.round(rate.tdeeKcal * 1.1)));
      // A bound day is reported for every scheduled day, and only then.
      const scheduled = (kind: "training" | "rest") =>
        kind === "training" ? trainingDays > 0 : trainingDays < 7;
      for (const day of ["training", "rest"] as const) {
        expect(targets.floorsBound.includes(`${day}:kcal`))
          .toBe(scheduled(day) && rate.bound === "kcal_min");
        expect(targets.floorsBound.includes(`${day}:fat`))
          .toBe(scheduled(day) && Math.round(0.25 * rate.targetKcal / 9) < 50);
      }

      if (kind === "no-floor") {
        const weeklyAverage = (trainingDays * targets.training.kcal
          + (7 - trainingDays) * targets.rest.kcal) / 7;
        // The engine's promise is ≤ 1 kcal against the integer-gram macro base; that base itself
        // sits within ±2 kcal of the requested number because carbs are whole grams.
        const { protein, fat } = targets.training;
        const macroBase = 4 * protein + 9 * fat
          + 4 * Math.round((rate.targetKcal - 4 * protein - 9 * fat) / 4);
        expect(Math.abs(macroBase - rate.targetKcal)).toBeLessThanOrEqual(2);
        expect(Math.abs(weeklyAverage - macroBase)).toBeLessThanOrEqual(1);
        expect(targets.floorsBound).toEqual([]);
        expect(rate.bound).toBeNull();
      }
    },
  );
});

describe("reference persona — 58-year-old woman, 160 lb (ruling 2026-09-22)", () => {
  // The case that exposed the old table: female, born 1968, 170 cm, 72.6 kg, "moderate", recomp.
  // The old scheme gave 2,115 kcal average (2,215 / 1,983); the conservative table gives 1,873 —
  // Mifflin 1,337.5 × 1.40 — with recomp at maintenance. A typed 32 % body fat changes nothing
  // (step C); only a recent measured value selects Katch-McArdle (1,436 × 1.40 ≈ 2,011).
  const persona: EnergyProfile = { sex: "female", birthYear: 1968, heightCm: 170, weightKg: 72.6,
    bodyFatPct: null, activityLevel: "moderate", goal: "recomp", goalRateBpWeek: 0 };
  const today = new Date(2026, 8, 22);

  it("derives about 1,870 kcal a day, never the old 2,115", () => {
    expect(bmr(persona, today)).toBe(1337.5);
    const targets = deriveTargets(persona, today, 4);
    expect(targets.training).toEqual({ protein: 145, carbs: 227, fat: 52, kcal: 1956 });
    expect(targets.rest).toEqual({ protein: 145, carbs: 178, fat: 52, kcal: 1760 });
    const weekly = (4 * targets.training.kcal + 3 * targets.rest.kcal) / 7;
    expect(Math.abs(weekly - 1873)).toBeLessThanOrEqual(1);
    expect(targets.floorsBound).toEqual([]);
  });

  it.each<[Goal, number, number, "rate_cap" | null]>([
    ["lose_fat", -25, 1673, null], ["lose_fat", -50, 1498, "rate_cap"],
    ["lose_fat", -75, 1498, "rate_cap"], ["gain_muscle", 10, 1953, null],
    ["gain_muscle", 20, 2033, null], ["gain_muscle", 25, 2060, "rate_cap"],
  ])("locks %s at %s bp/week to %s kcal a day (ruling 2026-09-22)", (goal, bp, kcal, bound) => {
    const targets = deriveTargets({ ...persona, goal, goalRateBpWeek: bp }, today, 4);
    expect(targets.rate.tdeeKcal).toBe(1873);
    expect(targets.rate.targetKcal).toBe(kcal);
    expect(targets.rate.bound).toBe(bound);
    // Whole-gram macros put the base within 2 kcal of the target, and cycling within 1 of that.
    const weekly = (4 * targets.training.kcal + 3 * targets.rest.kcal) / 7;
    expect(Math.abs(weekly - kcal)).toBeLessThanOrEqual(3);
    // Neither minimum binds (loss 1,430, gain 1,374); only the 50 g fat floor may, below 1,800.
    expect(targets.floorsBound.filter((bound) => !bound.endsWith(":fat"))).toEqual([]);
  });

  it("names the cap when −50 bp is held at 20 % below TDEE, about −0.47 %/week", () => {
    const { rate } = deriveTargets({ ...persona, goal: "lose_fat", goalRateBpWeek: -50 },
      today, 4);
    expect(rate.bound).toBe("rate_cap");
    expect(rate.effectiveRatePctWeek).toBeCloseTo(-0.47, 2);
    expect(rate.kcalMin).toBe(1430);
  });

  it("gives recomp 145 P / 52 F / 206 C and maintain 131 P / 52 F / 220 C before cycling", () => {
    const recomp = deriveTargets(persona, today, 0);
    const maintain = deriveTargets({ ...persona, goal: "maintain" }, today, 0);
    expect(recomp.rest).toEqual({ protein: 145, fat: 52, carbs: 206, kcal: 1872 });
    expect(maintain.rest).toEqual({ protein: 131, fat: 52, carbs: 220, kcal: 1872 });
  });

  it("makes recomp equal to maintenance in energy", () => {
    const recomp = deriveTargets(persona, today, 4);
    const maintain = deriveTargets({ ...persona, goal: "maintain" }, today, 4);
    // Protein differs by goal (2.0 vs 1.8 g/kg); the weekly energy does not.
    const weekly = (t: typeof recomp) => (4 * t.training.kcal + 3 * t.rest.kcal) / 7;
    expect(Math.abs(weekly(recomp) - weekly(maintain))).toBeLessThanOrEqual(2);
  });

  it("keeps every level's energy in order and moves Katch-McArdle with body fat", () => {
    const levels: ActivityLevel[] = ["sedentary", "light", "moderate", "active", "very_active"];
    const kcal = levels.map((activityLevel) =>
      deriveTargets({ ...persona, activityLevel }, today, 4).training.kcal);
    for (let i = 1; i < kcal.length; i += 1) expect(kcal[i]).toBeGreaterThan(kcal[i - 1]);
    const scan = { bodyFatSource: "dexa", bodyFatMeasuredOn: "2026-09-01" } as const;
    expect(bmr({ ...persona, bodyFatPct: 32, ...scan }, today))
      .toBeGreaterThan(bmr({ ...persona, bodyFatPct: 40, ...scan }, today));
  });

  it("ignores a typed 32 % and uses Katch-McArdle only for a recent scan", () => {
    expect(bmr({ ...persona, bodyFatPct: 32 }, today)).toBe(1337.5);
    expect(bmr({ ...persona, bodyFatPct: 32, bodyFatSource: "dexa",
      bodyFatMeasuredOn: "2026-09-01" }, today)).toBeCloseTo(1436.35, 2);
  });
});

describe("profile helpers", () => {
  it("rejects an incomplete profile", () => {
    expect(isProfileComplete(defaultSettings())).toBe(false);
  });

  it("builds an energy profile from complete settings", () => {
    const settings = { ...defaultSettings(), sex: "female" as const, birthYear: 1996,
      heightCm: 165, weightKg: 60, activityLevel: "moderate" as const,
      goal: "recomp" as const };
    expect(isProfileComplete(settings)).toBe(true);
    expect(energyProfileFrom(settings)).toEqual({
      sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
      bodyFatPct: null, bodyFatSource: null, bodyFatMeasuredOn: null,
      activityLevel: "moderate", goal: "recomp", goalRateBpWeek: 0,
    });
  });

  it("gives an account that never confirmed a rate 0 bp, not the goal's default", () => {
    const settings = { ...defaultSettings(), sex: "female" as const, birthYear: 1996,
      heightCm: 165, weightKg: 60, activityLevel: "moderate" as const,
      goal: "lose_fat" as const };
    expect(energyProfileFrom(settings).goalRateBpWeek).toBe(0);
    expect(energyProfileFrom({ ...settings, goalRateBpWeek: -25 }).goalRateBpWeek).toBe(-25);
  });

  it("prefers the latest weigh-in over the onboarding weight", () => {
    const settings = { ...defaultSettings(), weightKg: 60 };
    expect(weightForTargets(settings, 59.25)).toBe(59.25);
    expect(weightForTargets(settings, null)).toBe(60);
  });
});

describe("target revision derivation", () => {
  it("uses the explicit training weekday count for cycling", () => {
    const revision = deriveTargetRevision({
      settings: {
        ...defaultSettings(),
        sex: "male",
        birthYear: 1990,
        heightCm: 190,
        weightKg: 100,
        activityLevel: "active",
        goal: "maintain",
      },
      latestWeighInKg: null,
      today: "2026-09-19",
      trainingWeekdays: [1],
    });

    // Male, 36 y, 190 cm, 100 kg, active (1.55), maintain: 3,119 kcal → 404 g mean carbs,
    // one training day at +10 %, six rest days absorbing the difference.
    expect(revision.training.carbs).toBe(445);
    expect(revision.rest.carbs).toBe(397);
    expect(revision).toMatchObject({ floorsBound: [] });
    // Step E1: the revision freezes the formula start it was built on. Mifflin 2,012.5 → 2,013.
    expect(revision.seed).toEqual({ initialTdeeKcal: 3119, bmrKcal: 2013, bmrMethod: "mifflin",
      activityModelVersion: "activity-2026-09-22", derivationVersion: "derive-2026-10-04" });
  });

  it("freezes a Katch-McArdle seed only for a recent measured body fat (step E1)", () => {
    const base = { ...defaultSettings(), sex: "male" as const, birthYear: 1990, heightCm: 190,
      weightKg: 100, activityLevel: "active" as const, goal: "maintain" as const,
      bodyFatPct: 20 };
    const measured = deriveTargetRevision({ latestWeighInKg: null, today: "2026-09-19",
      trainingWeekdays: [1], settings: { ...base, bodyFatSource: "inbody",
        bodyFatMeasuredOn: "2026-09-01" } });
    // 370 + 21.6 × 80 kg lean mass = 2,098; × 1.55 = 3,251.9 → 3,252.
    expect(measured.seed).toMatchObject({ bmrKcal: 2098, bmrMethod: "katch",
      initialTdeeKcal: 3252 });
    const typed = deriveTargetRevision({ latestWeighInKg: null, today: "2026-09-19",
      trainingWeekdays: [1], settings: { ...base, bodyFatSource: "typed_unknown",
        bodyFatMeasuredOn: null } });
    expect(typed.seed).toMatchObject({ bmrKcal: 2013, bmrMethod: "mifflin" });
  });
});
