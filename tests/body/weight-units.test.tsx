import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bodyMetricSeries } from "@/components/BodyDashboard";
import WeightTrend, { toWeightUnit } from "@/components/WeightTrend";
import { formatWeekWeight } from "@/app/week/page";
import { formatWeight, kgToLb } from "@/lib/health/units";
import type { DailyHealthRow } from "@/lib/health/contract";

const day = (body_mass_kg: number): DailyHealthRow => ({
  local_date: "2026-09-20",
  steps: null,
  active_kcal: null,
  sleep_minutes: null,
  body_mass_kg,
  resting_heart_rate: null,
  hrv_sdnn: null,
  readiness_score: null,
  sources: [],
  provenance: {},
});

describe("weight display units", () => {
  it("formats one metric measurement in either preference", () => {
    expect(formatWeight(57.6, "lb")).toBe("127 lb");
    expect(formatWeight(57.6, "kg")).toBe("57.6 kg");
    expect(kgToLb(57.6)).toBeCloseTo(126.99, 2);
  });

  it("builds the Body weight card in the selected unit", () => {
    expect(bodyMetricSeries([day(57.6)], "lb")[0]).toMatchObject({
      value: "127 lb",
      points: [127],
    });
    expect(bodyMetricSeries([day(57.6)], "kg")[0]).toMatchObject({
      value: "57.6 kg",
      points: [57.6],
    });
  });

  it("labels and converts the weight trend in the selected unit", () => {
    expect(toWeightUnit([57.6, null], "kg")).toEqual([57.6, null]);
    expect(toWeightUnit([57.6, null], "lb")).toEqual([127, null]);

    const markup = renderToStaticMarkup(createElement(WeightTrend, {
      status: "estimating",
      weighInCount: 20,
      trendKg: [57.6, 57.5],
      unit: "kg",
    }));
    expect(markup).toContain("Weight trend in kilograms");
    expect(markup).toContain("A 20-day average, in kilograms.");
  });

  it("uses the shared compact weight formatting on Week", () => {
    expect(formatWeekWeight(150, "lb")).toBe("150 lb");
    expect(formatWeekWeight(150, "kg")).toBe("68 kg");
  });
});
