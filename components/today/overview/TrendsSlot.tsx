"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import MetricChips, { METRIC_LABEL } from "@/components/charts/MetricChips";
import MiniTrend from "@/components/charts/MiniTrend";
import TrendBars, { type TrendColumn } from "@/components/charts/TrendBars";
import TrendLine from "@/components/charts/TrendLine";
import Segmented, { tabId } from "@/components/ui/Segmented";
import CardFrame from "@/components/ui/CardFrame";
import { DisclosurePanel } from "@/components/ui/Disclosure";
import type { OverviewData } from "@/components/today/overview/types";
import type { WeightUnit } from "@/lib/health/units";
import { insights } from "@/lib/trends/insights";
import {
  dailyPoints, formatMetric, goalProgress, monthDay, sevenDayMean, weekdayShort, weeklyPoints,
  type TrendDay, type TrendMetric, type TrendPoint,
} from "@/lib/trends/series";
import { STREAK_LABEL, STREAK_MEANS, streakFigure, streaks } from "@/lib/trends/streaks";
import type { HealthWindow } from "@/lib/trends/sources";
import { useTrends } from "@/lib/trends/use-trends";
import type { WaterUnit } from "@/lib/water-units";
import styles from "@/components/today/overview/TrendsCard.module.css";

type Range = "week" | "month";
type Units = { weightUnit: WeightUnit; waterUnit: WaterUnit };
type Health = HealthWindow | { status: "loading" };

const MINIS: TrendMetric[] = ["kcal", "sleep", "activity"];
const HEALTH_METRICS = new Set<TrendMetric>(["sleep", "activity", "weight"]);
const INTAKE = new Set<TrendMetric>(["kcal", "protein"]);
const NOUN: Record<TrendMetric, string> = {
  kcal: "calories", protein: "protein", water: "water", sleep: "sleep", activity: "activity", weight: "weight",
};

/** One column's readout: "Tue · 1,840 kcal · target 2,000 kcal". A missing value is said, never 0. */
export function describePoint(metric: TrendMetric, point: TrendPoint, range: Range, units: Units): string {
  const when = range === "week" ? weekdayShort(point.date) : `Week of ${monthDay(point.date)}`;
  if (point.value === null) return `${when} · ${INTAKE.has(metric) || metric === "water" ? "nothing logged" : "no data"}`;
  const floor = point.partial ? (INTAKE.has(metric) ? "at least " : "so far ") : "";
  const avg = range === "month" ? " a day" : "";
  const target = point.target !== null ? ` · target ${formatMetric(metric, point.target, units)}` : "";
  const days = range === "month" ? ` · ${point.days} of 7 days` : "";
  return `${when} · ${floor}${formatMetric(metric, point.value, units)}${metric === "weight" ? "" : avg}${target}${days}`;
}

function average(points: TrendPoint[]): { value: number; n: number } | null {
  const known = points.filter((p) => p.value !== null && !p.partial).map((p) => p.value as number);
  if (known.length === 0) return null;
  return { value: known.reduce((a, b) => a + b, 0) / known.length, n: known.length };
}

/** What stands in for a chart with nothing to draw, or null when there is something. */
function emptyLine(metric: TrendMetric, points: TrendPoint[], health: Health): { text: string; connect?: boolean } | null {
  if (points.some((p) => p.value !== null)) return null;
  if (HEALTH_METRICS.has(metric)) {
    if (health.status === "loading") return { text: "Loading…" };
    if (health.status === "off") return { text: `Connect health to see ${NOUN[metric]}`, connect: true };
    if (health.status === "unavailable") return { text: "Health data isn't available right now." };
    return { text: metric === "weight" ? "No weigh-ins in these days." : `No ${NOUN[metric]} recorded in these days.` };
  }
  return { text: metric === "water" ? "No water logged in these days yet." : "Nothing logged in these days yet." };
}

function goalLine(metric: TrendMetric, days: TrendDay[], range: Range): string | null {
  const span = range === "week" ? days.slice(-7) : days;
  if (INTAKE.has(metric) && !span.some((d) => (metric === "kcal" ? d.kcalTarget : d.proteinTarget) !== null)) {
    return "Targets start once your profile is finished.";
  }
  const progress = goalProgress(dailyPoints(span, metric), metric);
  if (!progress) return null;
  const what = metric === "kcal" ? "Within 10% of your calorie target" : metric === "protein" ? "Protein target reached" : "Water goal reached";
  return `${what} on ${progress.met} of ${progress.of} ${progress.of === 1 ? "day" : "days"}.`;
}

/** The collapsed figure under a mini chart: the 7-day average, or a word for why there is none. */
function miniFigure(metric: TrendMetric, days: TrendDay[] | null, health: Health, units: Units): string {
  const mean = days ? sevenDayMean(days, metric, units.weightUnit) : null;
  if (mean !== null) return `${formatMetric(metric, mean, units)} avg`;
  if (HEALTH_METRICS.has(metric)) {
    if (health.status === "loading") return "…";
    if (health.status === "off") return "Connect";
  }
  return "No data";
}

/**
 * "Your week" in the Overview face (UI makeover §4.1, §11 W4). Collapsed it is one compact row of
 * three mini charts (Calories, Sleep, Activity) with each one's 7-day average; tapping one opens it
 * in place: the big chart with six measures, 7 days or 4 weeks, goal progress against the revision
 * in force on each date, three streaks and up to three insights computed in code. Every missing day
 * is a gap; nothing is drawn as 0 that was not recorded as 0.
 */
export default function TrendsSlot({ data, active }: {
  data: OverviewData;
  /** True while the Overview face is on show. */
  active: boolean;
}) {
  const { days, health } = useTrends({ store: data.store, today: data.today, active, cupsNow: data.water?.cups });
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<TrendMetric>("kcal");
  const [range, setRange] = useState<Range>("week");
  const [selected, setSelected] = useState<number | null>(null);
  const panelId = useId();
  const chartId = useId();
  const units: Units = { weightUnit: data.store?.settings.weightUnit ?? "lb", waterUnit: data.water?.unit ?? "cups" };

  const points = useMemo(() => {
    if (!days) return [];
    return range === "week" ? dailyPoints(days.slice(-7), metric, units.weightUnit) : weeklyPoints(days, metric, units.weightUnit);
  }, [days, metric, range, units.weightUnit]);
  const found = useMemo(() => (days ? insights(days) : []), [days]);
  const runs = useMemo(() => (days ? streaks(days) : []), [days]);

  if (!data.store) return null;

  const tapMini = (next: TrendMetric) => {
    setSelected(null);
    if (open && metric === next) { setOpen(false); return; }
    setMetric(next);
    setOpen(true);
  };
  const pick = (next: TrendMetric) => { setMetric(next); setSelected(null); };
  const pickRange = (next: Range) => { setRange(next); setSelected(null); };

  const cols: TrendColumn[] = points.map((p) => ({
    label: range === "week" ? weekdayShort(p.date) : monthDay(p.date),
    describe: describePoint(metric, p, range, units),
    value: p.value, target: p.target, partial: p.partial,
    training: metric === "activity" && range === "week" ? p.training : false,
  }));
  const label = METRIC_LABEL[metric];
  const span = range === "week" ? "last 7 days" : "last 4 weeks";
  const mean = average(points);
  const summary = mean
    ? `${label}, ${span}: averages ${formatMetric(metric, mean.value, units)} over ${mean.n} ${range === "week" ? "days" : "weeks"}.`
    : `${label}, ${span}: no data.`;
  const readout = selected !== null && cols[selected] ? cols[selected].describe
    : mean ? `${range === "week" ? "7-day" : "4-week"} average ${formatMetric(metric, mean.value, units)}` : " ";
  const empty = emptyLine(metric, points, health);
  const goal = days ? goalLine(metric, days, range) : null;
  const chartProps = { cols, metric, selected, onSelect: setSelected, summary,
    caption: `${label}, ${span}`, valueHeading: label };

  return <CardFrame as="section" size="sm" aria-label="Your week">
    <h2 className="sr-only">Your week</h2>
    <div className={styles.row}>
      {MINIS.map((m) => {
        const recent = days ? dailyPoints(days.slice(-7), m, units.weightUnit) : [];
        const figure = miniFigure(m, days, health, units);
        return <button key={m} type="button" className={`${styles.mini} tap`} aria-expanded={open && metric === m}
          aria-controls={open ? panelId : undefined} aria-label={`${METRIC_LABEL[m]}: ${figure}. ${open && metric === m ? "Close" : "Open"} chart`}
          onClick={() => tapMini(m)}>
          <span className="text-overline uppercase text-muted">{METRIC_LABEL[m]}</span>
          <MiniTrend metric={m} values={recent.map((p) => p.value)} partial={recent.map((p) => p.partial)} />
          <span className="truncate text-tiny font-semibold text-charcoal">{figure}</span>
        </button>;
      })}
    </div>
    <DisclosurePanel id={panelId} open={open} keepMounted={false}>
      <div className={styles.open}>
        <MetricChips value={metric} onChange={pick} />
        <Segmented label="Range" panel={chartId} value={range} onChange={pickRange}
          options={[{ value: "week", label: "7 days" }, { value: "month", label: "4 weeks" }]} />
        <div id={chartId} role="tabpanel" aria-labelledby={tabId(range)} className="flex flex-col gap-2">
          <p className="m-0 truncate text-caption text-charcoal" aria-live="polite">{empty ? " " : readout}</p>
          {empty
            ? <p className="m-0 text-caption text-muted" data-empty={metric}>
              {empty.connect ? <Link className="underline" href="/settings">{empty.text}</Link> : empty.text}
            </p>
            : metric === "weight"
              ? <TrendLine {...chartProps} maxGap={range === "week" ? 3 : 1} />
              : <TrendBars {...chartProps} />}
          {goal && <p className="m-0 text-caption text-graphite">{goal}</p>}
          {metric === "activity" && <p className="m-0 text-caption text-muted">Workouts aren&apos;t recorded yet.</p>}
        </div>
        <div className={styles.streaks} role="list" aria-label="Streaks">
          {runs.map((s) => <div key={s.kind} role="listitem" className={styles.streak}
            aria-label={`${STREAK_LABEL[s.kind]}: ${streakFigure(s)} ${STREAK_MEANS[s.kind]}`}>
            <span aria-hidden="true" className="text-heading font-display text-charcoal">{streakFigure(s)}</span>
            <span aria-hidden="true" className="truncate text-tiny text-muted">{STREAK_LABEL[s.kind]}</span>
          </div>)}
        </div>
        {found.length > 0 && <ul className={styles.insights} aria-label="What your days show">
          {found.map((insight) => <li key={insight.kind} className={`${styles.insight} text-caption text-charcoal`}>{insight.text}</li>)}
        </ul>}
        <Link href="/week" className="tap inline-flex min-h-11 items-center self-start text-caption font-semibold text-charcoal underline">
          See week
        </Link>
      </div>
    </DisclosurePanel>
  </CardFrame>;
}
