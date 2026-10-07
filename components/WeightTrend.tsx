"use client";

/**
 * The gated weight-trend line on /body, mounted by `BodyDashboard` after the metric cards. It has
 * no empty state: it does not mount. An exp-3 estimate gates on its `phase` (provisional or
 * adaptive) and needs two stored trend points to draw a line; an exp-2 row keeps the old rule —
 * past `burn_in` with at least 20 weigh-ins (F-091). `shouldMountWeightTrend` holds both; this
 * component checks again so a future caller cannot bypass the gate.
 *
 * Storage stays kilograms; the selected preference controls display only. `null` is a gap in the
 * line, never a zero — Sparkline renders it as one.
 */
import Sparkline from "@/components/Sparkline";
import { shouldMountWeightTrend } from "@/lib/estimator-client";
import type { ExpenditureResponse } from "@/lib/api-types";
import { LB_PER_KG, type WeightUnit } from "@/lib/health/units";
import { loadStore } from "@/lib/store";

export const WEIGHT_LB_PER_KG = LB_PER_KG;

export function toPounds(points: (number | null)[]): (number | null)[] {
  return toWeightUnit(points, "lb");
}

export function toWeightUnit(
  points: (number | null)[],
  unit: WeightUnit,
): (number | null)[] {
  return points.map((kg) => kg === null ? null
    : Math.round((unit === "lb" ? kg * WEIGHT_LB_PER_KG : kg) * 10) / 10);
}

/** A line needs two stored points; one reading, or a run of held nights, is not yet a trend. */
function drawable(points: (number | null)[]): boolean {
  return points.filter((point) => point !== null).length >= 2;
}

export default function WeightTrend({ status, weighInCount, trendKg, unit, phase = null }: {
  status: ExpenditureResponse["status"]; weighInCount: number; trendKg: (number | null)[];
  unit?: WeightUnit;
  /** Absent or null on an exp-2 row: the status rule decides. */
  phase?: ExpenditureResponse["phase"];
}) {
  if (!shouldMountWeightTrend(status, weighInCount, phase)) return null;
  const phased = phase === "provisional" || phase === "adaptive";
  if (phased && !drawable(trendKg)) return null;
  const displayUnit = unit ?? loadStore().settings.weightUnit ?? "lb";
  const unitName = displayUnit === "lb" ? "pounds" : "kilograms";
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 p-4">
        <h2 className=" text-heading-sm font-medium leading-heading-sm tracking-heading-sm text-charcoal">
          Weight trend
        </h2>
        <Sparkline points={toWeightUnit(trendKg, displayUnit)} label={`Weight trend in ${unitName}`}
          stroke="rgb(var(--section-rgb))" />
        {/* exp-3 fits a line through the window it used (14 or 28 days); exp-2 stored a 20-day average. */}
        <p className="text-tiny font-normal text-muted">
          {phased ? `The line through your weigh-ins, in ${unitName}.` : `A 20-day average, in ${unitName}.`}
          {" "}Day-to-day water is smoothed out.
        </p>
      </div>
    </section>
  );
}
