import { describe, expect, it } from "vitest";
import {
  ACTIVE_ENERGY_MIN_DAYS,
  ACTIVITY_BASELINE_DAYS,
  ACTIVITY_BASELINE_MIN_DAYS,
  ACTIVITY_CONTEXT_VERSION,
  ACTIVITY_CURRENT_DAYS,
  ACTIVITY_CURRENT_MIN_DAYS,
  ACTIVITY_DEVIATION_THRESHOLD_PCT,
  ACTIVITY_MIN_ABSOLUTE_DELTA_STEPS,
  ACTIVITY_TARGET_KCAL_CAP,
  ACTIVITY_TARGET_KCAL_COEFFICIENT,
  APPLE_SYNC_STALE_HOURS,
  summarizeActivity,
} from "@/lib/activity/summary";
import type { DailyHealthRow } from "@/lib/health/contract";

const AS_OF = "2026-09-20";
const DAY_MS = 86_400_000;

function dateAtAge(age: number): string {
  return new Date(Date.parse(`${AS_OF}T00:00:00Z`) - age * DAY_MS).toISOString().slice(0, 10);
}

function row(age: number, steps: number | null, activeKcal: number | null = null): DailyHealthRow {
  return {
    local_date: dateAtAge(age), steps, active_kcal: activeKcal,
    sleep_minutes: null, body_mass_kg: null, resting_heart_rate: null,
    hrv_sdnn: null, readiness_score: null, sources: [], provenance: {},
  };
}

function windowRows(current: number, baseline: number): DailyHealthRow[] {
  return [
    ...Array.from({ length: 7 }, (_, index) => row(index + 1, current)),
    ...Array.from({ length: 28 }, (_, index) => row(index + 8, baseline)),
  ];
}

describe("activity constants", () => {
  it("pins every design-v2 section 1 activity value", () => {
    expect({
      ACTIVITY_CONTEXT_VERSION,
      ACTIVITY_CURRENT_DAYS,
      ACTIVITY_BASELINE_DAYS,
      ACTIVITY_CURRENT_MIN_DAYS,
      ACTIVITY_BASELINE_MIN_DAYS,
      ACTIVITY_DEVIATION_THRESHOLD_PCT,
      ACTIVITY_MIN_ABSOLUTE_DELTA_STEPS,
      ACTIVE_ENERGY_MIN_DAYS,
      APPLE_SYNC_STALE_HOURS,
      ACTIVITY_TARGET_KCAL_COEFFICIENT,
      ACTIVITY_TARGET_KCAL_CAP,
    }).toEqual({
      ACTIVITY_CONTEXT_VERSION: "activity-1.0.0",
      ACTIVITY_CURRENT_DAYS: 7,
      ACTIVITY_BASELINE_DAYS: 28,
      ACTIVITY_CURRENT_MIN_DAYS: 5,
      ACTIVITY_BASELINE_MIN_DAYS: 14,
      ACTIVITY_DEVIATION_THRESHOLD_PCT: 0.25,
      ACTIVITY_MIN_ABSOLUTE_DELTA_STEPS: 1_500,
      ACTIVE_ENERGY_MIN_DAYS: 3,
      APPLE_SYNC_STALE_HOURS: 36,
      ACTIVITY_TARGET_KCAL_COEFFICIENT: 0,
      ACTIVITY_TARGET_KCAL_CAP: 0,
    });
  });
});

describe("summarizeActivity", () => {
  it("uses only completed local days in the exact 7-day and preceding 28-day windows", () => {
    const context = summarizeActivity([
      ...windowRows(6_000, 8_000),
      row(0, 99_999),
      row(36, 99_999),
    ], AS_OF, "America/Denver");

    expect(context).toMatchObject({
      version: "activity-1.0.0", asOf: AS_OF, timeZone: "America/Denver",
      currentStepsAvg: 6_000, currentDays: 7,
      baselineStepsAvg: 8_000, baselineDays: 28,
      deviationPct: -0.25, band: "usual",
      residualKcal: null, smoothing: "base", targetAdjustmentKcal: 0,
    });
  });

  it("requires at least 5 current and 14 baseline observed step days", () => {
    const fourCurrent = [
      ...Array.from({ length: 4 }, (_, index) => row(index + 1, 4_000)),
      ...Array.from({ length: 14 }, (_, index) => row(index + 8, 8_000)),
    ];
    expect(summarizeActivity(fourCurrent, AS_OF, "UTC").band).toBe("insufficient");

    const fiveCurrent = [...fourCurrent, row(5, 4_000)];
    expect(summarizeActivity(fiveCurrent, AS_OF, "UTC").band).toBe("lower");

    const thirteenBaseline = [
      ...Array.from({ length: 5 }, (_, index) => row(index + 1, 4_000)),
      ...Array.from({ length: 13 }, (_, index) => row(index + 8, 8_000)),
    ];
    expect(summarizeActivity(thirteenBaseline, AS_OF, "UTC").band).toBe("insufficient");
  });

  it("treats a zero baseline as insufficient", () => {
    expect(summarizeActivity(windowRows(4_000, 0), AS_OF, "UTC")).toMatchObject({
      baselineStepsAvg: 0, baselineDays: 28, band: "insufficient", deviationPct: null,
    });
  });

  it("keeps exact 0.75 and 1.25 ratios usual", () => {
    expect(summarizeActivity(windowRows(6_000, 8_000), AS_OF, "UTC").band).toBe("usual");
    expect(summarizeActivity(windowRows(10_000, 8_000), AS_OF, "UTC").band).toBe("usual");
  });

  it("requires an absolute step delta of at least 1,500", () => {
    expect(summarizeActivity(windowRows(3_501, 5_000), AS_OF, "UTC").band).toBe("usual");
    expect(summarizeActivity(windowRows(3_500, 5_000), AS_OF, "UTC").band).toBe("lower");
    expect(summarizeActivity(windowRows(6_499, 5_000), AS_OF, "UTC").band).toBe("usual");
    expect(summarizeActivity(windowRows(6_500, 5_000), AS_OF, "UTC").band).toBe("higher");
  });

  it("counts numeric zero as observed and excludes null as missing", () => {
    const rows = [
      row(1, 0), row(2, 5_000), row(3, 5_000), row(4, 5_000), row(5, 5_000), row(6, null),
      ...Array.from({ length: 14 }, (_, index) => row(index + 8, 5_000)),
    ];
    expect(summarizeActivity(rows, AS_OF, "UTC")).toMatchObject({
      currentStepsAvg: 4_000, currentDays: 5, baselineDays: 14,
    });
  });

  it("averages active kcal separately after 3 observed current days and never lets it set the band", () => {
    const base = windowRows(8_000, 8_000);
    const two = base.map((item) => item.local_date === dateAtAge(1)
      ? { ...item, active_kcal: 300 }
      : item.local_date === dateAtAge(2) ? { ...item, active_kcal: 500 } : item);
    expect(summarizeActivity(two, AS_OF, "UTC")).toMatchObject({
      activeKcal7dAvg: null, activeKcalDays: 2, band: "usual",
    });
    const three = two.map((item) => item.local_date === dateAtAge(3)
      ? { ...item, active_kcal: 400 } : item);
    expect(summarizeActivity(three, AS_OF, "UTC")).toMatchObject({
      activeKcal7dAvg: 400, activeKcalDays: 3, band: "usual",
    });
  });
});
