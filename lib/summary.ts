/**
 * The weekly share summary. PRD §6.2, §8.
 *
 * Pure functions over an already-RESOLVED week (`ResolvedDay[]`) — this file
 * never touches storage, dates-as-clock, or the meal library. The caller
 * (app/week/page.tsx) is responsible for turning stored days into
 * `ResolvedDay`s; all the arithmetic and formatting below is unit-testable
 * without a DOM, localStorage, or a real clock.
 *
 * `today` is passed in explicitly (an ISO "yyyy-mm-dd") rather than read from
 * `Date.now()` internally, for the same reason plan.ts's date helpers take
 * every date as an argument: a pure function of its inputs is trivially
 * testable and never drifts with the reader's timezone or the moment it runs.
 */

import type { ResolvedDay, SlotId } from "./types";
import { APP_NAME } from "@/lib/brand";

/**
 * Only the account's planned meal slots count as "hit or missed". Non-meal
 * entries and historical ritual slots never count as missed meals.
 */
const MEAL_SLOTS: SlotId[] = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// -------------------------------------------------------- local date math
//
// Mirrors the LOCAL-midnight parsing discipline in plan.ts (never
// `new Date("yyyy-mm-dd")`, which is UTC and can land on the wrong day in a
// timezone behind UTC). plan.ts's own version of this is private, and this
// file must stay a pure formatter with no dependency on the logic layer's
// internals, so the few lines are re-stated here rather than exported from
// plan.ts for one caller.

function partsOf(dateStr: string): { y: number; m: number; d: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { y, m, d };
}

function weekdayAbbrev(dateStr: string): string {
  const { y, m, d } = partsOf(dateStr);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

function formatDateRange(startDate: string, endDate: string): string {
  const start = partsOf(startDate);
  const end = partsOf(endDate);
  const startLabel = `${MONTHS[start.m - 1]} ${start.d}`;

  if (start.y !== end.y) {
    return `${startLabel}, ${start.y}–${MONTHS[end.m - 1]} ${end.d}, ${end.y}`;
  }
  if (start.m !== end.m) {
    return `${startLabel}–${MONTHS[end.m - 1]} ${end.d}`;
  }
  return `${startLabel}–${end.d}`;
}

// ------------------------------------------------------------ small maths

function average(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** "1890" -> "1,890". Written by hand rather than `toLocaleString` so the
 * output never depends on the runtime's ICU data being present. */
function formatThousands(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "127.4" stays "127.4"; a whole-number log like "128" becomes "128.0" so a
 * weigh-in always reads with the one decimal a bathroom scale gives it —
 * matching the shape used elsewhere in the Week screen and the PRD §8
 * example. Exported so app/week/page.tsx's compact weight chip stays
 * consistent with this text. */
export function formatWeight(lb: number): string {
  return lb.toFixed(1);
}

// ------------------------------------------------------------- the stats

export type WeekStats = {
  rangeLabel: string;
  /** null when the week has no scoreable (already-past) day yet. */
  meals: { hit: number; total: number; pct: number } | null;
  protein: { avg: number; target: number } | null;
  calories: { avg: number; target: number } | null;
  /**
   * The Week screen's headline number (PRD §6.2: "protein hit-rate and
   * calorie average ... the two numbers that matter"). Distinct from
   * `protein` above — this is the share of scoreable days where the user reached
   * the protein target, not the gram average the share text reports.
   */
  proteinHitRate: { met: number; total: number; pct: number } | null;
  /** null when no day in the week logged a gut check-in. */
  gut: { good: number; iffy: number; flare: number } | null;
  /** null when no day in the week logged a weight. */
  weight: { first: number; last: number; count: number } | null;
  floorDays: { count: number; days: string[] };
  /** OD10: past days logged more than 10 % above their calorie target. A neutral note, never a score. */
  overTargetDays: string[];
  /** "Sat Meal 2" style entries, oldest first. */
  missed: string[];
};

/**
 * Roll a week of already-resolved days into the numbers the Week screen and
 * the share summary both need.
 *
 * A day only counts toward "meals hit", "missed", protein/calorie averages
 * once it is fully in the past (`date < today`). PRD §6.2's grey dot is
 * "future/untouched" and the red dot is "past and missed" — the same line
 * separates "not due yet" from "was due and skipped" here. `today` itself is
 * excluded too: a meal not yet reached this afternoon is not a miss.
 * Gut check-ins, weigh-ins and Floor Day are counted over the WHOLE week
 * regardless of `today`, because those are explicitly logged —
 * there is nothing to wait on.
 */
/** A day counts as over target above 110 % of its calories, so rounding and a logged snack do not flag it. */
const OVER_TARGET_RATIO = 1.1;

export function computeWeekStats(weekDays: ResolvedDay[], today: string): WeekStats {
  if (weekDays.length === 0) {
    return {
      rangeLabel: "",
      meals: null,
      protein: null,
      calories: null,
      proteinHitRate: null,
      gut: null,
      weight: null,
      floorDays: { count: 0, days: [] },
      overTargetDays: [],
      missed: [],
    };
  }

  const rangeLabel = formatDateRange(weekDays[0].date, weekDays[weekDays.length - 1].date);
  const scoreableDays = weekDays.filter((d) => d.date < today);
  const targetDays = scoreableDays.filter(
    (d): d is ResolvedDay & { targets: NonNullable<ResolvedDay["targets"]> } => d.targets !== null,
  );

  const mealSlots = scoreableDays.flatMap((d) => d.slots.filter((s) => MEAL_SLOTS.includes(s.slot)));
  const hitMeals = mealSlots.filter((s) => s.eaten).length;
  const meals =
    mealSlots.length > 0
      ? { hit: hitMeals, total: mealSlots.length, pct: Math.round((hitMeals / mealSlots.length) * 100) }
      : null;

  const protein =
    targetDays.length > 0
      ? {
          avg: Math.round(average(targetDays.map((d) => d.consumed.protein))),
          target: Math.round(average(targetDays.map((d) => d.targets.protein))),
        }
      : null;

  const calories =
    targetDays.length > 0
      ? {
          avg: Math.round(average(targetDays.map((d) => d.consumed.kcal))),
          target: Math.round(average(targetDays.map((d) => d.targets.kcal))),
        }
      : null;

  const metProteinTarget = targetDays.filter((d) => d.consumed.protein >= d.targets.protein).length;
  const proteinHitRate =
    targetDays.length > 0
      ? {
          met: metProteinTarget,
          total: targetDays.length,
          pct: Math.round((metProteinTarget / targetDays.length) * 100),
        }
      : null;

  const gutCounts = { good: 0, iffy: 0, flare: 0 };
  for (const d of weekDays) if (d.gut) gutCounts[d.gut] += 1;
  const gut = gutCounts.good + gutCounts.iffy + gutCounts.flare > 0 ? gutCounts : null;

  const weighIns = weekDays.filter((d): d is ResolvedDay & { weightLb: number } => d.weightLb != null);
  const weight =
    weighIns.length > 0
      ? { first: weighIns[0].weightLb, last: weighIns[weighIns.length - 1].weightLb, count: weighIns.length }
      : null;

  const floorDayList = weekDays.filter((d) => d.isFloorDay);
  const floorDays = { count: floorDayList.length, days: floorDayList.map((d) => weekdayAbbrev(d.date)) };

  const overTargetDays = targetDays
    .filter((d) => d.targets.kcal > 0 && d.consumed.kcal > d.targets.kcal * OVER_TARGET_RATIO)
    .map((d) => weekdayAbbrev(d.date));

  const missed = scoreableDays.flatMap((d) =>
    d.slots
      .filter((s) => MEAL_SLOTS.includes(s.slot) && !s.eaten)
      .map((s) => `${weekdayAbbrev(d.date)} ${s.label}`)
  );

  return { rangeLabel, meals, protein, calories, proteinHitRate, gut, weight, floorDays, overTargetDays, missed };
}

/**
 * The exact plain-text block PRD §8 specifies for sharing a week.
 * Lines are omitted, not zero-filled, whenever their underlying data does
 * not exist yet (no weigh-in logged, no gut check-in logged, or no day in
 * the week has happened yet) — a blank "Weight: —" line would look like a
 * bug, not like "nothing logged".
 */
export function generateWeekSummary(weekDays: ResolvedDay[], today: string): string {
  const stats = computeWeekStats(weekDays, today);
  if (!stats.rangeLabel) return "";

  const lines: string[] = [`${APP_NAME} — ${stats.rangeLabel}`];

  if (stats.meals) {
    lines.push(`Meals hit: ${stats.meals.hit}/${stats.meals.total} (${stats.meals.pct}%)`);
  }
  if (stats.protein) {
    lines.push(`Protein: avg ${stats.protein.avg}g (target ${stats.protein.target})`);
  }
  if (stats.calories) {
    lines.push(`Calories: avg ${formatThousands(stats.calories.avg)} (target ${formatThousands(stats.calories.target)})`);
  }
  if (stats.gut) {
    lines.push(`Gut: ${stats.gut.good} good, ${stats.gut.iffy} iffy, ${stats.gut.flare} flare`);
  }
  if (stats.weight) {
    lines.push(
      stats.weight.count === 1
        ? `Weight: ${formatWeight(stats.weight.first)} lb`
        : `Weight: ${formatWeight(stats.weight.first)} → ${formatWeight(stats.weight.last)} lb`
    );
  }

  const floorLabel = stats.floorDays.days.length > 0 ? ` (${stats.floorDays.days.join(", ")})` : "";
  lines.push(`Floor days used: ${stats.floorDays.count}${floorLabel}`);

  if (stats.missed.length > 0) {
    lines.push(`Missed: ${stats.missed.join(", ")}`);
  }

  return lines.join("\n");
}
