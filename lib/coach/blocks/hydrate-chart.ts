import { LB_PER_KG } from "@/lib/health/units";
import type { ChartBlockV1 } from "@/lib/coach/ui-blocks";
import type { Macros } from "@/lib/types";

export type ChartArgs = {
  chart: "weight_trend" | "macros_today" | "kcal_week";
  days?: number;
};
export type WeightChartRow = { localDate: string; bodyMassKg: number };
export type KcalChartRow = { localDate: string; consumedKcal: number; targetKcal: number };
export type ChartHydrationInput = {
  id: string;
  weightUnit?: "lb" | "kg";
  weightRows?: readonly WeightChartRow[];
  /** `partial`: the day's consumed figures are a lower bound (#21); see `ChartBlockV1.partial`. */
  day?: { consumed: Macros; targets: Macros; partial?: boolean };
  kcalRows?: readonly KcalChartRow[];
};

const round1 = (value: number) => Math.round(value * 10) / 10;

function weightTrend(
  id: string, days: number, unit: "lb" | "kg", rows: readonly WeightChartRow[],
): ChartBlockV1 | null {
  const points = rows
    .filter((row) => Number.isFinite(row.bodyMassKg))
    .sort((a, b) => a.localDate.localeCompare(b.localDate))
    .map((row) => ({
      x: row.localDate,
      y: round1(unit === "lb" ? row.bodyMassKg * LB_PER_KG : row.bodyMassKg),
    }));
  if (points.length === 0) return null;
  return {
    kind: "chart", v: 1, id, chart: "weight_trend", days,
    series: [{ label: "Weight", points }], unit,
    caption: `Weight over the last ${days} days`,
  };
}

function macroPoints(macros: Macros) {
  return [
    { x: "protein", y: round1(macros.protein) },
    { x: "carbs", y: round1(macros.carbs) },
    { x: "fat", y: round1(macros.fat) },
    { x: "kcal", y: round1(macros.kcal) },
  ];
}

function macrosToday(id: string, day: ChartHydrationInput["day"]): ChartBlockV1 | null {
  if (!day) return null;
  return {
    kind: "chart", v: 1, id, chart: "macros_today",
    series: [
      { label: "Consumed", points: macroPoints(day.consumed) },
      { label: "Target", points: macroPoints(day.targets) },
    ],
    unit: "g / kcal", caption: "Today's macros and calories",
    ...(day.partial ? { partial: true } : {}),
  };
}

function kcalWeek(id: string, rows: readonly KcalChartRow[]): ChartBlockV1 | null {
  const logged = [...rows].sort((a, b) => a.localDate.localeCompare(b.localDate)).slice(-7);
  if (logged.length === 0) return null;
  return {
    kind: "chart", v: 1, id, chart: "kcal_week", days: logged.length,
    series: [
      { label: "Consumed", points: logged.map((row) =>
        ({ x: row.localDate, y: round1(row.consumedKcal) })) },
      { label: "Target", points: logged.map((row) =>
        ({ x: row.localDate, y: round1(row.targetKcal) })) },
    ],
    unit: "kcal", caption: `Calories over ${logged.length} logged ${logged.length === 1 ? "day" : "days"}`,
  };
}

export function hydrateChart(
  args: ChartArgs, input: ChartHydrationInput,
): ChartBlockV1 | null {
  if (args.chart === "weight_trend") {
    // The caller passes the account's unit (lib/coach/blocks/index.ts `accountWeightUnit`).
    return weightTrend(input.id, args.days ?? 30, input.weightUnit ?? "lb", input.weightRows ?? []);
  }
  if (args.chart === "macros_today") return macrosToday(input.id, input.day);
  return kcalWeek(input.id, input.kcalRows ?? []);
}
