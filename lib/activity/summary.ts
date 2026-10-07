import type { DailyHealthRow } from "@/lib/health/contract";
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
} from "@/lib/activity/constants";

export {
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
};

export type ActivityBand = "insufficient" | "usual" | "lower" | "higher";

export type ActivityContextV1 = {
  version: typeof ACTIVITY_CONTEXT_VERSION;
  asOf: string;
  timeZone: string;
  currentStepsAvg: number | null;
  currentDays: number;
  baselineStepsAvg: number | null;
  baselineDays: number;
  deviationPct: number | null;
  band: ActivityBand;
  activeKcal7dAvg: number | null;
  activeKcalDays: number;
  residualKcal: number | null;
  smoothing: "base" | "corroborated";
  targetAdjustmentKcal: 0;
};

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function valuesInWindow(
  rows: DailyHealthRow[], asOfDay: number, minimumAge: number, maximumAge: number,
  select: (row: DailyHealthRow) => number | null,
): number[] {
  return rows.flatMap((row) => {
    const age = asOfDay - dayNumber(row.local_date);
    const value = select(row);
    return age >= minimumAge && age <= maximumAge && value !== null ? [value] : [];
  });
}

function activityBand(current: number, baseline: number): ActivityBand {
  const deviation = (current - baseline) / baseline;
  const delta = current - baseline;
  if (deviation < -ACTIVITY_DEVIATION_THRESHOLD_PCT
    && delta <= -ACTIVITY_MIN_ABSOLUTE_DELTA_STEPS) return "lower";
  if (deviation > ACTIVITY_DEVIATION_THRESHOLD_PCT
    && delta >= ACTIVITY_MIN_ABSOLUTE_DELTA_STEPS) return "higher";
  return "usual";
}

export function summarizeActivity(
  rows: DailyHealthRow[], asOf: string, timeZone: string,
): ActivityContextV1 {
  const asOfDay = dayNumber(asOf);
  const currentSteps = valuesInWindow(
    rows, asOfDay, 1, ACTIVITY_CURRENT_DAYS, (row) => row.steps,
  );
  const baselineSteps = valuesInWindow(
    rows, asOfDay, ACTIVITY_CURRENT_DAYS + 1,
    ACTIVITY_CURRENT_DAYS + ACTIVITY_BASELINE_DAYS, (row) => row.steps,
  );
  const activeKcal = valuesInWindow(
    rows, asOfDay, 1, ACTIVITY_CURRENT_DAYS, (row) => row.active_kcal,
  );
  const currentStepsAvg = average(currentSteps);
  const baselineStepsAvg = average(baselineSteps);
  const hasCoverage = currentSteps.length >= ACTIVITY_CURRENT_MIN_DAYS
    && baselineSteps.length >= ACTIVITY_BASELINE_MIN_DAYS
    && baselineStepsAvg !== null
    && baselineStepsAvg !== 0;
  const deviationPct = hasCoverage && currentStepsAvg !== null
    ? (currentStepsAvg - baselineStepsAvg) / baselineStepsAvg
    : null;

  return {
    version: ACTIVITY_CONTEXT_VERSION,
    asOf,
    timeZone,
    currentStepsAvg,
    currentDays: currentSteps.length,
    baselineStepsAvg,
    baselineDays: baselineSteps.length,
    deviationPct,
    band: hasCoverage && currentStepsAvg !== null
      ? activityBand(currentStepsAvg, baselineStepsAvg)
      : "insufficient",
    activeKcal7dAvg: activeKcal.length >= ACTIVE_ENERGY_MIN_DAYS ? average(activeKcal) : null,
    activeKcalDays: activeKcal.length,
    residualKcal: null,
    smoothing: "base",
    targetAdjustmentKcal: 0,
  };
}
