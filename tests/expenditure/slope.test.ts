import { describe, expect, it } from "vitest";
import { lineAt, theilSen } from "@/lib/expenditure-slope";

describe("theilSen", () => {
  it("recovers an exact line", () => {
    const points = Array.from({ length: 28 }, (_, day) => ({ day, kg: 70 - 0.07 * day }));
    const line = theilSen(points)!;
    expect(line.slopeKgPerDay).toBeCloseTo(-0.07, 10);
    expect(lineAt(line, 27)).toBeCloseTo(70 - 0.07 * 27, 10);
    expect(line).toMatchObject({ points: 28, spanDays: 27 });
  });

  it("ignores a three-day 1.5 kg water spike that an endpoint delta would read as gain", () => {
    const points = Array.from({ length: 28 }, (_, day) => ({ day,
      kg: 70 + (day >= 25 ? 1.5 : 0) }));
    const line = theilSen(points)!;
    expect(Math.abs(line.slopeKgPerDay)).toBeLessThan(0.01);
    // The 14-day endpoint delta the v2 engine used: +1.5 kg / 14 d × 7700 ≈ −825 kcal/day.
    expect(Math.abs(line.slopeKgPerDay * 7700)).toBeLessThan(80);
  });

  it("keeps one reading per day (the last one given) and refuses fewer than two days", () => {
    expect(theilSen([{ day: 3, kg: 70 }, { day: 3, kg: 71 }])).toBeNull();
    expect(theilSen([])).toBeNull();
    const line = theilSen([{ day: 0, kg: 70 }, { day: 0, kg: 72 }, { day: 10, kg: 72 }])!;
    expect(line.slopeKgPerDay).toBe(0);
  });

  it("is unmoved by a single mistyped reading", () => {
    const points = Array.from({ length: 20 }, (_, day) => ({ day, kg: 60 + 0.02 * day }));
    points[10] = { day: 10, kg: 6.0 };
    expect(theilSen(points)!.slopeKgPerDay).toBeCloseTo(0.02, 3);
  });
});
