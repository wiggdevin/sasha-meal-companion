"use client";

import Chip from "@/components/ui/Chip";
import type { TrendMetric } from "@/lib/trends/series";

export const METRIC_LABEL: Record<TrendMetric, string> = {
  kcal: "Calories", protein: "Protein", water: "Water", sleep: "Sleep", activity: "Activity", weight: "Weight",
};

export const METRIC_ORDER: TrendMetric[] = ["kcal", "protein", "water", "sleep", "activity", "weight"];

/** The measure picker of the open chart: six chips in two rows of three, one chosen. */
export default function MetricChips({ value, onChange }: { value: TrendMetric; onChange: (next: TrendMetric) => void }) {
  return <div role="group" aria-label="Measure" className="pill-in grid grid-cols-3 gap-1 rounded-3xl p-1">
    {METRIC_ORDER.map((metric) => <Chip key={metric} selected={metric === value} onClick={() => onChange(metric)}>
      {METRIC_LABEL[metric]}
    </Chip>)}
  </div>;
}
