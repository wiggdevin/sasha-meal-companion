/**
 * T11b evals. The two formula BMRs and the two display window rules
 * (weight within 14 days, active energy over the last 7) — plus the guard that keeps this
 * module off the target path: nothing here may ever move a calorie target.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DailyHealthRow } from "@/lib/health/contract";
import {
  activeEnergy7d, ageYears, bmrKatchMcArdle, bmrMifflinStJeor, latestWeightKg,
} from "@/lib/tdee";

const LOCAL_DATE = "2026-09-12";

function day(local_date: string, over: Partial<DailyHealthRow> = {}): DailyHealthRow {
  return { local_date, steps: null, active_kcal: null, sleep_minutes: null, body_mass_kg: null,
    resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, sources: [], provenance: {},
    ...over };
}

function near(value: number, target: number, tolerance = 1): void {
  expect(Math.abs(value - target), `${value} is not within ${tolerance} of ${target}`)
    .toBeLessThanOrEqual(tolerance);
}

/** The active-energy provenance a rolled-up day carries, keyed by the source that produced it. */
function energyKind(kind: string): DailyHealthRow["provenance"] {
  return { active_energy: { kind, end: "2026-09-12T18:00:00Z" } };
}
const SEVEN_DAYS = [
  day("2026-09-06", { active_kcal: 300, sources: ["Apple Watch"],
    provenance: energyKind("health_auto_export") }),
  day("2026-09-07", { active_kcal: 350, sources: ["Apple Watch"],
    provenance: energyKind("health_auto_export") }),
  day("2026-09-08", { active_kcal: 400, sources: ["Oura"], provenance: energyKind("oura") }),
  day("2026-09-09", { active_kcal: 500, sources: ["Oura"], provenance: energyKind("oura") }),
  day("2026-09-10", { active_kcal: 450, sources: ["Oura"], provenance: energyKind("oura") }),
  day("2026-09-11", { active_kcal: 500, sources: ["Oura"], provenance: energyKind("oura") }),
  day("2026-09-12", { body_mass_kg: 70 }),
];

describe("the two BMR formulas", () => {
  it("Mifflin-St Jeor: 70 kg / 165 cm / 30 y / female is 1,420 kcal", () => {
    near(bmrMifflinStJeor(70, 165, 30, "female"), 1420);
  });

  // Sol r3 NIT: "unspecified" must take the midpoint, not silently fall through to the male term.
  it("Mifflin-St Jeor: 'unspecified' is the exact midpoint of male and female", () => {
    const male = bmrMifflinStJeor(70, 165, 30, "male");
    const female = bmrMifflinStJeor(70, 165, 30, "female");
    const unspecified = bmrMifflinStJeor(70, 165, 30, "unspecified");
    expect(unspecified).toBe((male + female) / 2);
  });

  it("Katch-McArdle: 70 kg at 25 % body fat is 1,504 kcal", () => {
    near(bmrKatchMcArdle(70, 25), 1504);
  });

  it("counts age in whole years from the birth year", () => {
    expect(ageYears(1996, LOCAL_DATE)).toBe(30);
  });
});

describe("the weight input", () => {
  it("takes the latest weigh-in inside 14 days", () => {
    const days = [day("2026-08-20", { body_mass_kg: 72 }), day("2026-09-01", { body_mass_kg: 70 }),
      day("2026-09-08", { body_mass_kg: 69.5 })];
    expect(latestWeightKg(days, LOCAL_DATE)).toBe(69.5);
  });

  // The rule is "within 14 days" and it is inclusive at exactly 14: a weigh-in on 29 Aug is 14 days
  // before 12 Sep and still counts, one on 28 Aug is 15 days old and does not. The formula line
  // disappears at that boundary, so both sides of it are pinned here (third round, finding 8).
  it("counts a weigh-in exactly 14 days old", () => {
    expect(latestWeightKg([day("2026-08-29", { body_mass_kg: 70 })], LOCAL_DATE)).toBe(70);
  });

  it("drops a weigh-in 15 days old", () => {
    expect(latestWeightKg([day("2026-08-28", { body_mass_kg: 70 })], LOCAL_DATE)).toBeNull();
  });

  it("prefers the newest when a 14-day-old weigh-in sits beside an older one", () => {
    const days = [day("2026-08-28", { body_mass_kg: 71 }), day("2026-08-29", { body_mass_kg: 70 }),
      day("2026-08-01", { body_mass_kg: 73 })];
    expect(latestWeightKg(days, LOCAL_DATE)).toBe(70);
  });

  it("is null when every weigh-in is older than 14 days", () => {
    expect(latestWeightKg([day("2026-08-01", { body_mass_kg: 70 })], LOCAL_DATE)).toBeNull();
    expect(latestWeightKg([], LOCAL_DATE)).toBeNull();
  });
});

describe("the active-energy window", () => {
  it("averages the days that carry active energy and counts them", () => {
    const energy = activeEnergy7d(SEVEN_DAYS, LOCAL_DATE);
    expect(energy.daysWithData).toBe(6);
    expect(Math.round(energy.avgKcal)).toBe(417);
    // Newest day first, and only each day's `provenance.active_energy.kind` (finding 6).
    expect(energy.sourceKinds).toEqual(["oura", "health_auto_export"]);
  });

  it("ignores days outside the last 7", () => {
    const days = [day("2026-09-01", { active_kcal: 9999 }), day("2026-09-12", { active_kcal: 100 })];
    expect(activeEnergy7d(days, LOCAL_DATE).avgKcal).toBe(100);
  });

  it("attributes the energy to its own provenance, not to every device seen that day", () => {
    const days = ["2026-09-10", "2026-09-11", "2026-09-12"].map((date) => day(date, {
      active_kcal: 400, body_mass_kg: 70,
      // The day also carries Oura sleep, so `sources` names Oura as well.
      sources: ["Oura", "Sasha's iPhone"],
      provenance: { active_energy: { kind: "health_auto_export", end: `${date}T18:00:00Z` },
        sleep_asleep: { kind: "oura", end: `${date}T07:00:00Z` } },
    }));
    expect(activeEnergy7d(days, LOCAL_DATE).sourceKinds).toEqual(["health_auto_export"]);
  });
});

describe("lib/tdee.ts is display-only", () => {
  const TARGET_PATH = [
    "lib/expenditure.ts", "lib/expenditure.fixtures.ts",
    "lib/proposal.ts", "lib/server/expenditure.ts", "lib/server/proposals.ts",
    "lib/targets.ts", "lib/targets/percent.ts", "lib/server/targets.ts", "lib/resolve.ts",
    "app/api/jobs/estimate/route.ts", "app/api/jobs/weekly-proposal/route.ts",
    "app/api/targets/route.ts", "app/api/expenditure/route.ts",
  ];
  const DISPLAY_ONLY_PATH = [
    ...TARGET_PATH,
    "lib/ai/adapter.ts", "lib/ai/capture.ts", "lib/ai/prompts.ts", "lib/ai/attestation.ts",
    "app/api/proposals/route.ts", "app/api/log/propose/route.ts",
  ];

  it("is imported by no file on the target path", () => {
    for (const file of DISPLAY_ONLY_PATH) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not import lib/tdee`)
        .not.toMatch(/["'`]@\/lib\/tdee["'`]|["'`]\.\.?\/tdee["'`]/);
    }
  });

  it("keeps the body-profile write modules out of target, proposal, estimator, and AI paths", () => {
    const forbiddenImport = /body-profile-(?:client|fields)/;
    const targetsRoute = "app/api/targets/route.ts";
    for (const file of DISPLAY_ONLY_PATH) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not import the body-profile write path`).not.toMatch(forbiddenImport);
      if (file !== targetsRoute) {
        expect(source, `${file} must not receive body-profile fields`)
          .not.toMatch(/height_cm|birth_year|body_fat_pct|heightCm|birthYear|bodyFatPct/);
      }
    }
    const source = readFileSync(targetsRoute, "utf8");
    // D1: target revisions accept body-profile provenance, but never import the display-only TDEE.
    // Step D validates settings with `settingsSchema.refine(...)` for the rate preset, so the guard
    // follows the derivation rather than the name: whatever the route names in `settings:`, it must
    // be the one shared object schema or a refinement of it, never a schema of the route's own.
    const settingsField = source.match(/settings:\s*(\w+Schema)/);
    expect(settingsField?.[1], "the targets route must validate settings with a shared schema").toBeTruthy();
    if (settingsField![1] !== "settingsSchema") {
      expect(source).toMatch(new RegExp(`const ${settingsField![1]} = settingsSchema\\.`));
    }
    expect(source).toMatch(/input:\s*{\s*settings,/);
    expect(source).not.toMatch(/["'`]@\/lib\/tdee["'`]|["'`]\.\.?\/tdee["'`]/);
  });

  it("keeps profile values out of analytics and application logging", () => {
    const profileSources = [
      "lib/body-profile-client.ts", "lib/body-profile-fields.ts", "components/BodyProfileFields.tsx",
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(profileSources).not.toMatch(/console\.(?:log|info|debug|warn|error)\s*\(/);
    expect(profileSources).not.toMatch(/analytics|telemetry|capture\s*\(/i);
  });
});
