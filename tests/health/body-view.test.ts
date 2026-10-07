import { describe, expect, it } from "vitest";
import { bodyMetricSeries, daysWithData, formatMetric, kgToLb, lastSeen }
  from "@/components/BodyDashboard";
import type { DailyHealthRow } from "@/lib/health/contract";

const row = (local_date: string, over: Partial<DailyHealthRow> = {}): DailyHealthRow => ({
  local_date, steps: null, active_kcal: null, sleep_minutes: null, body_mass_kg: null,
  resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, sources: [], provenance: {},
  ...over });

describe("the body view helpers", () => {
  it("renders an em dash for an absent observation, never a zero", () => {
    expect(formatMetric(null, "steps")).toBe("—");
    expect(formatMetric(0, "steps")).toBe("0 steps");
    expect(formatMetric(1300, "steps")).toBe("1,300 steps");
  });

  it("shows weight in pounds while storage stays kilograms", () => {
    expect(kgToLb(57.6)).toBeCloseTo(127.0, 1);
    expect(formatMetric(Math.round(kgToLb(57.6) * 10) / 10, "lb")).toBe("127 lb");
  });

  it("counts the days that actually carry data", () => {
    expect(daysWithData([1, null, 3, null, null, 6, 7])).toBe(4);
    expect(daysWithData([null, null])).toBe(0);
  });

  it("says how long ago a source last delivered, or never", () => {
    const now = new Date("2026-09-15T14:00:00Z");
    expect(lastSeen(null, now)).toBe("never");
    expect(lastSeen("2026-09-15T10:00:00Z", now)).toBe("4 h ago");
    expect(lastSeen("2026-09-15T13:45:00Z", now)).toBe("15 min ago");
    expect(lastSeen("2026-09-12T14:00:00Z", now)).toBe("3 d ago");
  });

  // T11b finding 3: readiness is stored by the Oura pull and was drawn nowhere. The card is the
  // seventh series, and a day without a score is a gap in the line, never a zero.
  it("draws readiness as its own series, with the days that have none as gaps", () => {
    const series = bodyMetricSeries([
      row("2026-09-15", { readiness_score: 78 }),
      row("2026-09-16", { readiness_score: 70 }),
      row("2026-09-17"),
    ]);
    expect(series.map((card) => card.eyebrow)).toEqual(["Weight", "Sleep", "Steps",
      "Device active energy estimate",
      "Resting heart rate", "HRV", "Readiness"]);
    const readiness = series[series.length - 1];
    expect(readiness.points).toEqual([78, 70, null]);
    expect(readiness.value).toBe("70 score");
    expect(readiness.footnote).toBe("2 of 3 days with data");
  });
});
