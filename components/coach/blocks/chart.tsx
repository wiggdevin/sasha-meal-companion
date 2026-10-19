"use client";

import MacroRings from "@/components/MacroRings";
import Sparkline from "@/components/Sparkline";
import type { ChartBlockV1 } from "@/lib/coach/ui-blocks";
import type { Macros } from "@/lib/types";

const CAPTION = "text-tiny font-normal text-muted";
const CHART_WIDTH = 280;
const CHART_HEIGHT = 72;

function pointsFor(block: ChartBlockV1, label: string) {
  return block.series.find((row) => row.label.toLowerCase() === label)?.points ?? [];
}

function lastValue(block: ChartBlockV1): number | null {
  // macros_today is keyed by nutrient, not by time: announce the kcal point, whatever its order.
  if (block.chart === "macros_today") return values(block.series, "consumed").get("kcal") ?? null;
  const label = block.chart === "weight_trend" ? "weight" : "consumed";
  const points = pointsFor(block, label);
  return points.length > 0 ? points[points.length - 1].y : null;
}

function values(series: ChartBlockV1["series"], label: string): Map<string, number> {
  return new Map(series.find((row) => row.label.toLowerCase() === label)?.points
    .map((point) => [point.x, point.y]) ?? []);
}

function macrosOf(block: ChartBlockV1, label: string): Macros | null {
  const points = values(block.series, label);
  const keys = ["protein", "carbs", "fat", "kcal"] as const;
  if (keys.some((key) => !points.has(key))) return null;
  return Object.fromEntries(keys.map((key) => [key, points.get(key)])) as Macros;
}

function KcalWeek({ block, label }: { block: ChartBlockV1; label: string }) {
  const consumed = block.series.find((row) => row.label.toLowerCase() === "consumed")?.points ?? [];
  const targets = values(block.series, "target");
  const peak = Math.max(1, ...consumed.map((point) => point.y), ...targets.values());
  const step = CHART_WIDTH / Math.max(7, consumed.length);
  const barWidth = Math.min(24, step - 6);
  const y = (value: number) => CHART_HEIGHT - (Math.max(0, value) / peak) * CHART_HEIGHT;
  const targetPath = consumed.map((point, index) =>
    `${index === 0 ? "M" : "L"}${index * step + step / 2},${y(targets.get(point.x) ?? 0)}`
  ).join(" ");
  return (
    <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={label}
      className="h-[72px] w-full overflow-visible">
      {consumed.map((point, index) => {
        const top = y(point.y);
        return <rect key={point.x} x={index * step + (step - barWidth) / 2} y={top}
          width={barWidth} height={CHART_HEIGHT - top} rx="4"
          fill="var(--color-gauge-calories)" />;
      })}
      {targetPath && <path d={targetPath} fill="none" stroke="var(--color-text-secondary)"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

export default function ChartBlock({ block }: { block: ChartBlockV1 }) {
  if (!block.series.some((series) => series.points.length > 0)) return null;
  const last = lastValue(block);
  const aria = `${block.caption}; last value ${last ?? "unavailable"}${last === null ? "" : ` ${block.unit}`}`;
  if (block.chart === "macros_today") {
    const consumed = macrosOf(block, "consumed");
    const targets = macrosOf(block, "target");
    if (!consumed || !targets) return null;
    return <div className="flex flex-col gap-2" role="group" aria-label={aria}>
      <MacroRings consumed={consumed} targets={targets} partial={block.partial === true} />
      <p className={`m-0 px-1 ${CAPTION}`}>{block.caption}</p>
    </div>;
  }
  return (
    <figure className="shell m-0" aria-label={aria}>
      <div className="surface card-sm card-ivory flex flex-col">
        {block.chart === "weight_trend"
          ? <Sparkline points={pointsFor(block, "weight").map((point) => point.y)} width={280}
              height={56} label={aria} />
          : <KcalWeek block={block} label={aria} />}
        <figcaption className={CAPTION}>{block.caption}</figcaption>
      </div>
    </figure>
  );
}
