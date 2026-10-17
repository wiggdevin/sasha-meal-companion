/**
 * TDEE step F (docs/plans/2026-09-22-tdee-engine-plan.md §F): the derivation properties and the
 * date boundaries the plan names that no other test held. The persona values themselves live in
 * lib/profile/energy.test.ts; this file adds the property checks over many seeded profiles.
 *
 * "fast-check" is not a dependency, so the profiles come from the fixtures' seeded LCG: every run
 * draws the same 150 profiles, and a failure names the profile that broke.
 */
import { describe, expect, it } from "vitest";
import { fromDayNumber, toDayNumber } from "@/lib/expenditure";
import { lcg } from "@/lib/expenditure.fixtures";
import { deriveTargetRevision } from "@/lib/profile/derive";
import {
  activityFactor, bmr, deriveTargets, katchEligible, tdee, type EnergyProfile,
} from "@/lib/profile/energy";
import { DEFAULT_RATE_BP, RATE_PRESETS_BP } from "@/lib/profile/rate-goal";
import { defaultSettings } from "@/lib/store";
import type { ActivityLevel, Goal } from "@/lib/types";

const TODAY = new Date("2026-09-19T12:00:00Z");
const LEVELS: ActivityLevel[] = ["sedentary", "light", "moderate", "active", "very_active"];
const GOALS: Goal[] = ["lose_fat", "recomp", "maintain", "gain_muscle"];
const SEXES = ["female", "male", "unspecified"] as const;

/** 150 adult profiles, 40–140 kg, 145–200 cm, 18–80 years, every sex and level. */
function profiles(count = 150): EnergyProfile[] {
  const next = lcg(20261017);
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
  return Array.from({ length: count }, () => ({
    sex: pick(SEXES),
    birthYear: 2026 - (18 + Math.floor(next() * 63)),
    heightCm: Math.round(145 + next() * 55),
    weightKg: Math.round((40 + next() * 100) * 10) / 10,
    bodyFatPct: null,
    activityLevel: pick(LEVELS),
    goal: "maintain",
    goalRateBpWeek: 0,
  }));
}

const label = (p: EnergyProfile) =>
  `${p.sex} ${p.birthYear} ${p.heightCm} cm ${p.weightKg} kg ${p.activityLevel} ${p.goal}`;
const weekly = (t: ReturnType<typeof deriveTargets>, trainingDays: number) =>
  (trainingDays * t.training.kcal + (7 - trainingDays) * t.rest.kcal) / 7;

describe("step F properties — BMR", () => {
  it("Mifflin rises 10 kcal per kg and 6.25 per cm, and falls 5 per year of age", () => {
    for (const p of profiles()) {
      const base = bmr(p, TODAY);
      expect(bmr({ ...p, weightKg: p.weightKg + 1 }, TODAY) - base, label(p)).toBeCloseTo(10, 9);
      expect(bmr({ ...p, heightCm: p.heightCm + 1 }, TODAY) - base, label(p)).toBeCloseTo(6.25, 9);
      expect(bmr({ ...p, birthYear: p.birthYear - 1 }, TODAY) - base, label(p)).toBeCloseTo(-5, 9);
    }
  });

  it("Katch-McArdle falls 0.216 × weight kcal per body-fat point at a fixed weight", () => {
    const scan = { bodyFatSource: "dexa", bodyFatMeasuredOn: "2026-09-01" } as const;
    for (const p of profiles(60)) {
      let previous = Infinity;
      for (let pct = 8; pct <= 50; pct += 6) {
        const value = bmr({ ...p, bodyFatPct: pct, ...scan }, TODAY);
        expect(value, `${label(p)} at ${pct} %`).toBeLessThan(previous);
        expect(value).toBeCloseTo(370 + 21.6 * p.weightKg * (1 - pct / 100), 9);
        previous = value;
      }
    }
  });
});

describe("step F properties — TDEE and the goal", () => {
  it("TDEE rises strictly with every activity level, by exactly the table's factor", () => {
    for (const p of profiles()) {
      const values = LEVELS.map((activityLevel) => tdee({ ...p, activityLevel }, TODAY));
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i], label(p)).toBeGreaterThan(values[i - 1]);
      }
      LEVELS.forEach((level, i) => expect(values[i])
        .toBeCloseTo(bmr(p, TODAY) * activityFactor(level), 9));
    }
  });

  // Loss and recomp dose protein at 2.0 g/kg, maintain and gain at 1.8, so each goal has its own
  // macro minimum. Where the loss minimum binds (small, sedentary profiles) the loss target sits
  // ABOVE maintenance; that case is pinned separately below, not hidden.
  it("loss ≤ maintenance ≤ gain at every preset, and the TDEE never depends on the goal", () => {
    let checked = 0;
    for (const p of profiles()) {
      const maintain = deriveTargets({ ...p, goal: "maintain", goalRateBpWeek: 0 }, TODAY, 3);
      for (const bp of RATE_PRESETS_BP.lose_fat) {
        const loss = deriveTargets({ ...p, goal: "lose_fat", goalRateBpWeek: bp }, TODAY, 3);
        expect(loss.rate.tdeeKcal, label(p)).toBe(maintain.rate.tdeeKcal);
        if (loss.rate.bound === "kcal_min") {
          expect(loss.rate.targetKcal, label(p)).toBe(loss.rate.kcalMin);
          continue;
        }
        checked += 1;
        expect(loss.rate.targetKcal, label(p)).toBeLessThan(maintain.rate.targetKcal);
      }
      for (const bp of RATE_PRESETS_BP.gain_muscle) {
        const gain = deriveTargets({ ...p, goal: "gain_muscle", goalRateBpWeek: bp }, TODAY, 3);
        expect(gain.rate.tdeeKcal, label(p)).toBe(maintain.rate.tdeeKcal);
        expect(gain.rate.targetKcal, label(p)).toBeGreaterThanOrEqual(maintain.rate.targetKcal);
        if (maintain.rate.bound === null) {
          expect(gain.rate.targetKcal, label(p)).toBeGreaterThan(maintain.rate.targetKcal);
        }
      }
    }
    // Most draws are ordinary profiles: the ordering is really exercised, not skipped.
    expect(checked).toBeGreaterThan(300);
  });

  it("where the minimums bind, loss sits above maintenance by the protein difference", () => {
    // Unspecified, 77 y, 145 cm, 49.8 kg, sedentary: Mifflin 941.25 × 1.2 → TDEE 1,130. Maintain
    // (90 g protein) is raised to its 1,210 minimum; loss (100 g protein) to 1,250, so the loss
    // target sits 40 kcal above maintenance. A known edge of the ruling's own floor, recorded here.
    const p: EnergyProfile = { sex: "unspecified", birthYear: 1949, heightCm: 145, weightKg: 49.8,
      bodyFatPct: null, activityLevel: "sedentary", goal: "maintain", goalRateBpWeek: 0 };
    const maintain = deriveTargets(p, TODAY, 3);
    const loss = deriveTargets({ ...p, goal: "lose_fat", goalRateBpWeek: -50 }, TODAY, 3);
    expect(maintain.rate).toMatchObject({ tdeeKcal: 1130, kcalMin: 1210, targetKcal: 1210,
      bound: "kcal_min" });
    expect(loss.rate).toMatchObject({ tdeeKcal: 1130, kcalMin: 1250, targetKcal: 1250,
      bound: "kcal_min" });
  });

  it("recomp is maintenance in energy (0 bp, same target kcal); only protein differs", () => {
    for (const p of profiles()) {
      const recomp = deriveTargets({ ...p, goal: "recomp", goalRateBpWeek: 0 }, TODAY, 4);
      const maintain = deriveTargets({ ...p, goal: "maintain", goalRateBpWeek: 0 }, TODAY, 4);
      expect(DEFAULT_RATE_BP.recomp).toBe(0);
      expect(recomp.rate.tdeeKcal, label(p)).toBe(maintain.rate.tdeeKcal);
      // As above, recomp's 2.0 g/kg minimum can bind where maintain's does not.
      if (recomp.rate.bound === null && maintain.rate.bound === null) {
        expect(recomp.rate.targetKcal, label(p)).toBe(maintain.rate.targetKcal);
        expect(recomp.rate.targetKcal, label(p)).toBe(recomp.rate.tdeeKcal);
      }
      expect(recomp.training.protein, label(p)).toBeGreaterThanOrEqual(maintain.training.protein);
    }
  });
});

describe("step F properties — macros for every training-day count", () => {
  it("protein is the same both days, no macro is negative, Atwater holds, the week is on target",
    () => {
      for (const p of profiles()) {
        for (const goal of GOALS) {
          for (let trainingDays = 0; trainingDays <= 7; trainingDays += 1) {
            const t = deriveTargets({ ...p, goal, goalRateBpWeek: DEFAULT_RATE_BP[goal] },
              TODAY, trainingDays);
            const name = `${label(p)} ${goal} ${trainingDays} days`;
            expect(t.training.protein, name).toBe(t.rest.protein);
            for (const day of [t.training, t.rest]) {
              expect(day.protein, name).toBeGreaterThan(0);
              expect(day.carbs, name).toBeGreaterThanOrEqual(100);
              expect(day.fat, name).toBeGreaterThanOrEqual(50);
              expect(day.kcal, name).toBe(4 * day.protein + 4 * day.carbs + 9 * day.fat);
              expect(day.kcal, name).toBeGreaterThanOrEqual(t.rate.kcalMin);
            }
            // Whole grams put the base within 2 kcal of the target, cycling within 1 of that.
            if (t.floorsBound.length === 0) {
              expect(Math.abs(weekly(t, trainingDays) - t.rate.targetKcal), name)
                .toBeLessThanOrEqual(3);
            }
          }
        }
      }
    });
});

describe("step F — invalid inputs and the four-day default", () => {
  const settings = { ...defaultSettings(), sex: "female" as const, birthYear: 1990,
    heightCm: 165, weightKg: 60, activityLevel: "moderate" as const, goal: "maintain" as const };
  const derive = (over: Partial<Parameters<typeof deriveTargetRevision>[0]> = {}) =>
    deriveTargetRevision({ settings, latestWeighInKg: null, today: "2026-09-19",
      trainingWeekdays: [], ...over });

  it("refuses an incomplete profile, a malformed date and a rate that is not a preset", () => {
    expect(() => derive({ settings: { ...settings, heightCm: null } })).toThrow(/incomplete/);
    expect(() => derive({ settings: { ...settings, activityLevel: null } })).toThrow(/incomplete/);
    expect(() => derive({ today: "2026-9-19" })).toThrow(/YYYY-MM-DD/);
    expect(() => derive({ today: "19/09/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => derive({ today: "2027-02-29" })).toThrow(/YYYY-MM-DD/);
    expect(() => derive({ today: "2026-13-01" })).toThrow(/YYYY-MM-DD/);
    expect(() => derive({ settings: { ...settings, goal: "lose_fat", goalRateBpWeek: -40 } }))
      .toThrow(/preset/);
  });

  it("no training weekdays means no cycling, never a silent four", () => {
    const none = derive();
    expect(none.inputs.trainingWeekdays).toEqual([]);
    expect(none.training).toEqual(none.rest);
    const four = derive({ trainingWeekdays: [1, 2, 4, 5] });
    expect(four.training.carbs).toBeGreaterThan(four.rest.carbs);
    expect(four.training).not.toEqual(none.training);
  });

  it("counts each real weekday once and drops anything outside 0–6", () => {
    const messy = derive({ trainingWeekdays: [3, 3, 7, -1, 2.5] });
    expect(messy.inputs.trainingWeekdays).toEqual([3]);
    expect(messy.training).toEqual(derive({ trainingWeekdays: [3] }).training);
  });
});

describe("step F — birthday and leap-day boundaries", () => {
  const p: EnergyProfile = { sex: "female", birthYear: 1990, heightCm: 165, weightKg: 60,
    bodyFatPct: null, activityLevel: "moderate", goal: "maintain", goalRateBpWeek: 0 };

  it("age steps once, on 1 January UTC, by exactly 5 kcal; mid-year dates do not move it", () => {
    const dec31 = bmr(p, new Date("2026-12-31T12:00:00Z"));
    const jan1 = bmr(p, new Date("2027-01-01T12:00:00Z"));
    expect(dec31 - jan1).toBe(5);
    expect(bmr(p, new Date("2026-06-30T12:00:00Z"))).toBe(dec31);
    expect(bmr(p, new Date("2026-01-01T12:00:00Z"))).toBe(dec31);
  });

  it("29 February derives the same seed as 28 February of that year", () => {
    const settings = { ...defaultSettings(), sex: "male" as const, birthYear: 1980,
      heightCm: 180, weightKg: 82, activityLevel: "light" as const, goal: "maintain" as const };
    const on = (today: string) => deriveTargetRevision({ settings, latestWeighInKg: null, today,
      trainingWeekdays: [1, 3] });
    const leap = on("2028-02-29");
    expect(leap.effectiveFrom).toBe("2028-02-29");
    expect(leap.seed).toEqual(on("2028-02-28").seed);
    // Male, 48 y in 2028, 180 cm, 82 kg: 820 + 1,125 − 240 + 5 = 1,710; × 1.3 = 2,223.
    expect(leap.seed).toMatchObject({ bmrKcal: 1710, initialTdeeKcal: 2223 });
  });

  it("a scan dated 29 February stays measured for exactly 180 days; 29 Feb 2027 is no date", () => {
    const scan = (bodyFatMeasuredOn: string, today: string) => katchEligible({ bodyFatPct: 25,
      bodyFatSource: "dexa", bodyFatMeasuredOn }, new Date(`${today}T12:00:00Z`));
    expect(scan("2028-02-29", "2028-02-29")).toBe(true);
    expect(scan("2028-02-29", "2028-08-27")).toBe(true);
    expect(scan("2028-02-29", "2028-08-28")).toBe(false);
    expect(scan("2027-02-29", "2027-03-15")).toBe(false);
  });

  it("the engine's day numbers step through 29 February and the year end one day at a time", () => {
    expect(toDayNumber("2028-03-01") - toDayNumber("2028-02-28")).toBe(2);
    expect(toDayNumber("2027-03-01") - toDayNumber("2027-02-28")).toBe(1);
    expect(toDayNumber("2029-01-01") - toDayNumber("2028-01-01")).toBe(366);
    for (let day = toDayNumber("2027-12-01"); day < toDayNumber("2028-04-01"); day += 1) {
      expect(toDayNumber(fromDayNumber(day))).toBe(day);
    }
    expect(fromDayNumber(toDayNumber("2028-02-28") + 1)).toBe("2028-02-29");
  });
});
