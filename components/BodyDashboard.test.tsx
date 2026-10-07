import { describe, expect, it } from "vitest";
import { bodyMetricSeries, movementPattern } from "./BodyDashboard";
import type { ActivityContextV1 } from "@/lib/activity/summary";
import type { DailyHealthRow } from "@/lib/health/contract";

function day(overrides: Partial<DailyHealthRow>): DailyHealthRow {
  return {
    local_date: "2026-09-10", steps: null, active_kcal: null, sleep_minutes: null,
    body_mass_kg: null, sources: [], resting_heart_rate: null, hrv_sdnn: null,
    readiness_score: null, provenance: {}, ...overrides,
  };
}

describe("bodyMetricSeries", () => {
  it("formats the Sleep card headline as h:mm, matching BodyTodayCard's sleepText", () => {
    const series = bodyMetricSeries([day({ sleep_minutes: 444 })]);
    const sleep = series.find((card) => card.eyebrow === "Sleep");
    expect(sleep?.value).toBe("7:24");
  });

  it("names active calories as a device estimate", () => {
    expect(bodyMetricSeries([day({ active_kcal: 410 })])
      .some((card) => card.eyebrow === "Device active energy estimate")).toBe(true);
  });
});

describe("movementPattern", () => {
  const context = (band: ActivityContextV1["band"]): ActivityContextV1 => ({
    version: "activity-1.0.0", asOf: "2026-09-20", timeZone: "America/Denver",
    currentStepsAvg: 6_200, currentDays: 5, baselineStepsAvg: 8_000, baselineDays: 14,
    deviationPct: -0.225, band, activeKcal7dAvg: 410, activeKcalDays: 7,
    residualKcal: null, smoothing: "base", targetAdjustmentKcal: 0,
  });

  it.each([
    ["lower", "Lower than usual"], ["usual", "Near usual"], ["higher", "Higher than usual"],
  ] as const)("maps %s to %s with both coverage counts", (band, label) => {
    expect(movementPattern(context(band))).toEqual({
      label, currentCoverage: "5 of 7 recent days",
      baselineCoverage: "14 of 28 usual-range days",
    });
  });
});
