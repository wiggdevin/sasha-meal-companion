import { describe, expect, it } from "vitest";
import { hydrateChart } from "@/lib/coach/blocks/hydrate-chart";

const day = {
  date: "2026-09-19",
  consumed: { protein: 72, carbs: 140, fat: 38, kcal: 1300 },
  targets: { protein: 135, carbs: 240, fat: 70, kcal: 2200 },
};

describe("chart block hydration", () => {
  it("converts canonical weight rows into the user's pounds", () => {
    expect(hydrateChart({ chart: "weight_trend", days: 30 }, {
      id: "chart-1", weightUnit: "lb",
      weightRows: [
        { localDate: "2026-09-18", bodyMassKg: 57.6 },
        { localDate: "2026-09-19", bodyMassKg: 58 },
      ],
    })).toEqual({
      kind: "chart", v: 1, id: "chart-1", chart: "weight_trend", days: 30,
      series: [{ label: "Weight", points: [
        { x: "2026-09-18", y: 127 }, { x: "2026-09-19", y: 127.9 },
      ] }],
      unit: "lb", caption: "Weight over the last 30 days",
    });
  });

  it("uses today's context for consumed and target macros", () => {
    expect(hydrateChart({ chart: "macros_today" }, { id: "chart-2", day }))
      .toEqual({
        kind: "chart", v: 1, id: "chart-2", chart: "macros_today",
        series: [
          { label: "Consumed", points: [
            { x: "protein", y: 72 }, { x: "carbs", y: 140 },
            { x: "fat", y: 38 }, { x: "kcal", y: 1300 },
          ] },
          { label: "Target", points: [
            { x: "protein", y: 135 }, { x: "carbs", y: 240 },
            { x: "fat", y: 70 }, { x: "kcal", y: 2200 },
          ] },
        ],
        unit: "g / kcal", caption: "Today's macros and calories",
      });
  });

  it("keeps only the last seven logged calorie days", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      localDate: `2026-09-${String(index + 10).padStart(2, "0")}`,
      consumedKcal: index === 0 ? 0 : 1200 + index,
      targetKcal: 2100,
    }));
    const block = hydrateChart({ chart: "kcal_week" }, { id: "chart-3", kcalRows: rows });
    expect(block?.series[0].points).toHaveLength(7);
    expect(block?.series[0].points[0]).toEqual({ x: "2026-09-12", y: 1202 });
    expect(block).toMatchObject({
      chart: "kcal_week", days: 7, unit: "kcal",
      caption: "Calories over 7 logged days",
    });
  });

  it("states the actual number of logged calorie days", () => {
    const block = hydrateChart({ chart: "kcal_week" }, { id: "chart-4", kcalRows: [
      { localDate: "2026-09-10", consumedKcal: 1200, targetKcal: 2100 },
      { localDate: "2026-09-19", consumedKcal: 1400, targetKcal: 2200 },
    ] });

    expect(block).toMatchObject({ days: 2, caption: "Calories over 2 logged days" });
  });

  it("keeps a logged day even when its foods total zero calories", () => {
    const block = hydrateChart({ chart: "kcal_week" }, { id: "chart-5", kcalRows: [
      { localDate: "2026-09-19", consumedKcal: 0, targetKcal: 2200 },
    ] });

    expect(block).toMatchObject({
      days: 1, caption: "Calories over 1 logged day",
    });
    expect(block?.series[0].points).toEqual([{ x: "2026-09-19", y: 0 }]);
  });

  it.each([
    ["weight_trend", { id: "empty", weightRows: [], weightUnit: "kg" }],
    ["macros_today", { id: "empty" }],
    ["kcal_week", { id: "empty", kcalRows: [] }],
  ] as const)("returns no %s block when its source is empty", (chart, input) => {
    expect(hydrateChart({ chart }, input)).toBeNull();
  });
});
