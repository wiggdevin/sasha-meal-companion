import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveOnboardingSettings } from "../profile/onboarding-client";
import { defaultSettings } from "../store";
import { saveBodyProfile } from "../body-profile-client";
import { allOps } from "./idb";
import { settingsProfileFromRow, settingsProfileToRow, withBodyFatProvenance }
  from "./user-settings";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

describe("user_settings profile mapping", () => {
  it("round-trips a chosen meal count without creating one for a missing value", () => {
    expect(settingsProfileFromRow({ meals_per_day: 6 }).mealsPerDay).toBe(6);
    expect(settingsProfileToRow({ mealsPerDay: 2 }).meals_per_day).toBe(2);
    expect(settingsProfileFromRow({}).mealsPerDay).toBeNull();
  });
  beforeEach(async () => {
    h = await resetTestAccount();
    globalThis.indexedDB = new IDBFactory();
  });

  it("round-trips the profile and target fields between app and database names", () => {
    const settings = {
      ...defaultSettings(),
      heightCm: 165,
      heightUnit: "cm" as const,
      weightUnit: "kg" as const,
      birthYear: 1996,
      sex: "female" as const,
      bodyFatPct: 19.5,
      bodyFatSource: "inbody" as const,
      bodyFatMeasuredOn: "2026-09-01",
      weightKg: 57.6,
      activityLevel: "moderate" as const,
      goal: "lose_fat" as const,
      goalRateBpWeek: -50,
      trainingWeekdays: [1, 3, 4, 5],
      dietPrefs: { flags: ["no_dairy", "low_fodmap"], text: "Keep fibre gentle" },
      onboardedAt: "2026-09-19T18:00:00.000Z",
    };

    const row = settingsProfileToRow(settings);
    expect(row).toEqual({
      height_cm: 165,
      height_unit: "cm",
      weight_unit: "kg",
      birth_year: 1996,
      sex: "female",
      body_fat_pct: 19.5,
      body_fat_source: "inbody",
      body_fat_measured_on: "2026-09-01",
      weight_kg: 57.6,
      activity_level: "moderate",
      goal: "lose_fat",
      goal_rate_bp_week: -50,
      meals_per_day: null,
      training_weekdays: [1, 3, 4, 5],
      diet_prefs: { flags: ["no_dairy", "low_fodmap"], text: "Keep fibre gentle" },
      onboarded_at: "2026-09-19T18:00:00.000Z",
    });
    expect(settingsProfileFromRow(row)).toEqual({
      heightCm: 165,
      heightUnit: "cm",
      weightUnit: "kg",
      birthYear: 1996,
      sex: "female",
      bodyFatPct: 19.5,
      bodyFatSource: "inbody",
      bodyFatMeasuredOn: "2026-09-01",
      weightKg: 57.6,
      activityLevel: "moderate",
      goal: "lose_fat",
      goalRateBpWeek: -50,
      mealsPerDay: null,
      trainingWeekdays: [1, 3, 4, 5],
      dietPrefs: { flags: ["no_dairy", "low_fodmap"], text: "Keep fibre gentle" },
      onboardedAt: "2026-09-19T18:00:00.000Z",
    });
  });

  it("never sends a scan date the database cannot cast", () => {
    for (const bodyFatMeasuredOn of ["2026-02-30", "last spring", "2026-9-1"]) {
      expect(settingsProfileToRow({ ...defaultSettings(), bodyFatPct: 25,
        bodyFatSource: "dexa", bodyFatMeasuredOn }).body_fat_measured_on).toBeNull();
    }
  });

  it("reads an unknown source or a malformed scan date as unverified", () => {
    expect(settingsProfileFromRow({ body_fat_pct: 25, body_fat_source: "guess" as never,
      body_fat_measured_on: "last spring" })).toMatchObject({
      bodyFatPct: 25, bodyFatSource: null, bodyFatMeasuredOn: null });
  });

  it("maps omitted nullable columns to null", () => {
    expect(settingsProfileFromRow({})).toEqual({
      heightCm: null,
      heightUnit: "ft_in",
      weightUnit: "lb",
      birthYear: null,
      sex: null,
      bodyFatPct: null,
      bodyFatSource: null,
      bodyFatMeasuredOn: null,
      weightKg: null,
      activityLevel: null,
      goal: null,
      goalRateBpWeek: null,
      mealsPerDay: null,
      trainingWeekdays: null,
      dietPrefs: null,
      onboardedAt: null,
    });
  });

  it("preserves omitted, null, and valued activity-prompt dismissals", () => {
    expect(settingsProfileFromRow({})).not.toHaveProperty("activityPromptDismissedUntil");
    expect(settingsProfileFromRow({ activity_prompt_dismissed_until: null }))
      .toHaveProperty("activityPromptDismissedUntil", null);
    expect(settingsProfileFromRow({
      activity_prompt_dismissed_until: "2026-10-20T18:00:00.000Z",
    })).toHaveProperty("activityPromptDismissedUntil", "2026-10-20T18:00:00.000Z");

    expect(settingsProfileToRow({})).not.toHaveProperty("activity_prompt_dismissed_until");
    expect(settingsProfileToRow({ activityPromptDismissedUntil: null }))
      .toHaveProperty("activity_prompt_dismissed_until", null);
    expect(settingsProfileToRow({
      activityPromptDismissedUntil: "2026-10-20T18:00:00.000Z",
    })).toHaveProperty("activity_prompt_dismissed_until", "2026-10-20T18:00:00.000Z");
  });

  it("tolerates diet preferences without a flags array and keeps their text", () => {
    expect(settingsProfileFromRow({
      diet_prefs: { text: "Keep fibre gentle" } as never,
    }).dietPrefs).toEqual({ flags: [], text: "Keep fibre gentle" });
  });

  it("enqueues all profile fields under their user_settings column names", async () => {
    const writeTargets = vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      source: "derived" as const,
      effectiveFrom: "2026-09-19",
      training: { kcal: 2200, protein: 120, carbs: 250, fat: 80 },
      rest: { kcal: 1800, protein: 120, carbs: 150, fat: 80 },
      pins: { trainingKcal: null, restKcal: null, proteinG: null },
      inputs: { effectiveDate: "2026-09-19", weightKg: 57.6,
        weightSource: "onboarding" as const, trainingWeekdays: [1, 3, 4, 5],
        activity: "moderate" as const, goal: "recomp" as const, goalRateBpWeek: 0,
        formulaName: "profile-energy-v1" },
    }));
    await saveOnboardingSettings({
      ...defaultSettings(),
      heightCm: 165,
      birthYear: 1996,
      sex: "female",
      bodyFatPct: 19.5,
      weightKg: 57.6,
      activityLevel: "moderate",
      goal: "recomp",
      trainingWeekdays: [1, 3, 4, 5],
      dietPrefs: { flags: ["no_dairy"], text: "Keep fibre gentle" },
      onboardedAt: "2026-09-19T18:00:00.000Z",
    }, "complete", [], writeTargets);

    expect((await allOps(h))[0].payload).toMatchObject({
      height_cm: 165,
      birth_year: 1996,
      sex: "female",
      body_fat_pct: 19.5,
      weight_kg: 57.6,
      activity_level: "moderate",
      goal: "recomp",
      training_weekdays: [1, 3, 4, 5],
      diet_prefs: { flags: ["no_dairy"], text: "Keep fibre gentle" },
      onboarded_at: "2026-09-19T18:00:00.000Z",
    });
  });
});

describe("withBodyFatProvenance (step C: a new value never keeps an old scan label)", () => {
  const scanned = { body_fat_pct: 28, body_fat_source: "dexa", body_fat_measured_on: "2026-09-01" };

  it("clears the source and date when the value changes and the write keeps them", () => {
    expect(withBodyFatProvenance(scanned, { ...scanned, body_fat_pct: 30 })).toEqual({
      body_fat_pct: 30, body_fat_source: null, body_fat_measured_on: null });
  });

  it("keeps a source and date the same write sets with the new value", () => {
    const next = { body_fat_pct: 30, body_fat_source: "inbody", body_fat_measured_on: "2026-09-20" };
    expect(withBodyFatProvenance(scanned, next)).toEqual(next);
  });

  it("keeps the provenance when the value does not change", () => {
    expect(withBodyFatProvenance(scanned, { ...scanned, height_cm: 170 }))
      .toEqual({ ...scanned, height_cm: 170 });
  });

  it("clears the provenance when the value is cleared", () => {
    expect(withBodyFatProvenance(scanned, { ...scanned, body_fat_pct: null })).toEqual({
      body_fat_pct: null, body_fat_source: null, body_fat_measured_on: null });
  });

  it("reads an omitted source or date as unchanged, as _sync_upsert does", () => {
    expect(withBodyFatProvenance(scanned, { body_fat_pct: 30 })).toEqual({
      body_fat_pct: 30, body_fat_source: null, body_fat_measured_on: null });
  });

  it("leaves a write that does not carry body_fat_pct alone", () => {
    expect(withBodyFatProvenance(scanned, { height_cm: 170 })).toEqual({ height_cm: 170 });
  });
});

describe("a body-fat edit through the real outbox (step C)", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("queues a payload that clears a scan label the new value does not carry", async () => {
    await saveBodyProfile({ body_fat_pct: 24, body_fat_source: "dexa",
      body_fat_measured_on: "2026-09-01" });
    await saveBodyProfile({ body_fat_pct: 30 });
    const ops = await allOps(h);
    expect(ops.at(-1)?.payload).toMatchObject({
      body_fat_pct: 30, body_fat_source: null, body_fat_measured_on: null });
  });

  it("keeps the label when only another column changes", async () => {
    await saveBodyProfile({ body_fat_pct: 24, body_fat_source: "dexa",
      body_fat_measured_on: "2026-09-01" });
    await saveBodyProfile({ height_cm: 170 });
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({
      body_fat_pct: 24, body_fat_source: "dexa", body_fat_measured_on: "2026-09-01" });
  });
});
