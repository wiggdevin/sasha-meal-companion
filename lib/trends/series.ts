/**
 * The week's numbers for the Overview's "Your week" card (UI makeover §4.1). Pure.
 *
 * Intake is read from what the phone already stores for each past date: the day's log entries, an
 * eaten recipe snapshot and an eaten slot's saved lines. It never runs the meal generator: an eaten
 * slot nothing describes adds nothing and marks the day partial ("at least"). A date with no entry,
 * no eaten slot and no eaten recipe is a gap (`null`), never 0. Targets come from the revision in
 * force on each date (`resolveTargets`), so there is none before the account's first revision.
 */
import type { DailyHealthRow } from "@/lib/health/contract";
import { kgToLb, lbToKg, type WeightUnit } from "@/lib/health/units";
import { entryMacros } from "@/lib/plan/entry-macros";
import { consumedSnapshot, eatenPlanSnapshot, slotHasOwnLog } from "@/lib/plan/eaten-estimate";
import { resolveTargets, targetDayType } from "@/lib/targets";
import type { DayType, FoodComponent, SlotId, Store, StoredDay } from "@/lib/types";
import { formatWater, type WaterUnit } from "@/lib/water-units";

export type TrendMetric = "kcal" | "protein" | "water" | "sleep" | "activity" | "weight";

/** One date as the charts, streaks and insights read it. Every measure may be missing. */
export type TrendDay = {
  date: string;
  /** 0 Sunday … 6 Saturday. */
  weekday: number;
  today: boolean;
  dayType: DayType;
  kcal: number | null;
  protein: number | null;
  /** The intake is a floor: a partly measured entry, an undescribed eaten slot, or today so far. */
  intakePartial: boolean;
  kcalTarget: number | null;
  proteinTarget: number | null;
  /** The user marked the day "fully logged". */
  fullyLogged: boolean;
  cups: number | null;
  waterGoal: number | null;
  sleepMin: number | null;
  activeKcal: number | null;
  steps: number | null;
  weightKg: number | null;
};

/** One drawn value: a day, or (4 weeks) a week's mean over the days that have one. */
export type TrendPoint = {
  /** First date of the span. */
  date: string;
  end: string;
  value: number | null;
  target: number | null;
  partial: boolean;
  /** Days in the span with a value (a day is 0 or 1). */
  days: number;
  span: number;
  training: boolean;
};

/** `date` moved by `days`, as an ISO calendar date (no time zone is involved). */
export function isoShift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

/** The `n` dates ending on `end`, oldest first. */
export function windowDates(end: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => isoShift(end, i - (n - 1)));
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const sumLines = (lines: FoodComponent[]) => lines.reduce(
  (acc, line) => ({ kcal: acc.kcal + (line.macros?.kcal ?? 0), protein: acc.protein + (line.macros?.protein ?? 0) }),
  { kcal: 0, protein: 0 });

/**
 * What one stored day says was eaten, without the generator. `null` when nothing was recorded.
 * The rules follow `resolveDay`: a log filed under a slot is that slot's record; an eaten recipe
 * snapshot counts; a followPlan snapshot or a hand-edited slot's lines count; anything else that is
 * ticked is unknown and makes the day partial.
 */
export function dayIntake(day: StoredDay | undefined): { kcal: number; protein: number; partial: boolean } | null {
  if (!day) return null;
  const entries = day.extras ?? [];
  const eaten = Object.entries(day.eaten ?? {}).filter(([, at]) => !!at).map(([slot]) => slot as SlotId);
  if (entries.length === 0 && eaten.length === 0) return null;
  let kcal = 0;
  let protein = 0;
  let partial = false;
  for (const entry of entries) {
    const macros = entryMacros(entry);
    kcal += macros.kcal;
    protein += macros.protein;
    if (entry.nutritionPartial || entry.massUnknown) partial = true;
  }
  for (const slot of eaten) {
    if (slotHasOwnLog(day, slot)) continue;
    const lines = consumedSnapshot(day, slot)?.components ?? eatenPlanSnapshot(day, slot) ?? editedLines(day, slot);
    if (!lines) { partial = true; continue; }
    const sum = sumLines(lines);
    kcal += sum.kcal;
    protein += sum.protein;
  }
  return { kcal: Math.round(kcal), protein: Math.round(protein), partial };
}

/** A hand-edited slot's own lines (not a time-only edit, not cleared, not empty). */
function editedLines(day: StoredDay, slot: SlotId): FoodComponent[] | null {
  const override = day.itemOverrides?.[slot];
  if (!override || override.followPlan || override.cleared || override.components.length === 0) return null;
  return override.components;
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Every date of the window, oldest first, from the store, the water rows and the health rows. */
export function buildTrendDays({ store, today, dates, cups, waterGoal, health }: {
  store: Store;
  today: string;
  dates: string[];
  /** Stored cups by date; a date without a row is missing. */
  cups: ReadonlyMap<string, number> | null;
  /** The water goal in cups for a date and its day type, or null when it cannot be known. */
  waterGoal: ((date: string, dayType: DayType) => number | null) | null;
  health: DailyHealthRow[] | null;
}): TrendDay[] {
  const rows = new Map((health ?? []).map((row) => [row.local_date, row]));
  return dates.map((date) => {
    const day = store.days[date];
    const dayType = targetDayType(date, day?.dayTypeOverride, store.settings);
    const targets = resolveTargets(dayType, store.settings, date)?.macros ?? null;
    const intake = dayIntake(day);
    const fullyLogged = !!day?.dayCompleteAt;
    const row = rows.get(date);
    const storedCups = cups?.get(date);
    const healthKg = finite(row?.body_mass_kg);
    const loggedLb = finite(day?.weightLb);
    return {
      date, weekday: weekdayOf(date), today: date === today, dayType,
      kcal: intake?.kcal ?? null,
      protein: intake?.protein ?? null,
      intakePartial: !!intake && (intake.partial || (date === today && !fullyLogged)),
      kcalTarget: finite(targets?.kcal),
      proteinTarget: finite(targets?.protein),
      fullyLogged,
      cups: typeof storedCups === "number" && Number.isFinite(storedCups) ? storedCups : null,
      waterGoal: waterGoal ? waterGoal(date, dayType) : null,
      sleepMin: finite(row?.sleep_minutes),
      activeKcal: finite(row?.active_kcal),
      steps: finite(row?.steps),
      weightKg: healthKg ?? (loggedLb !== null ? lbToKg(loggedLb) : null),
    };
  });
}

/** The value a metric reads off one day, in its display unit (weight in the account's unit). */
export function dayValue(day: TrendDay, metric: TrendMetric, unit: WeightUnit = "lb"): {
  value: number | null; target: number | null; partial: boolean } {
  switch (metric) {
    case "kcal": return { value: day.kcal, target: day.kcalTarget, partial: day.intakePartial };
    case "protein": return { value: day.protein, target: day.proteinTarget, partial: day.intakePartial };
    case "water": return { value: day.cups, target: day.waterGoal, partial: day.today };
    case "sleep": return { value: day.sleepMin, target: null, partial: false };
    case "activity": return { value: day.activeKcal, target: null, partial: day.today };
    case "weight": {
      const kg = day.weightKg;
      const value = kg === null ? null : unit === "lb" ? kgToLb(kg) : kg;
      return { value: value === null ? null : Math.round(value * 10) / 10, target: null, partial: false };
    }
  }
}

/** One point per day. */
export function dailyPoints(days: TrendDay[], metric: TrendMetric, unit: WeightUnit = "lb"): TrendPoint[] {
  return days.map((day) => ({ date: day.date, end: day.date, ...dayValue(day, metric, unit),
    days: dayValue(day, metric, unit).value === null ? 0 : 1, span: 1, training: day.dayType !== "rest" }));
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Consecutive 7-day means, oldest first, over the days that have a value; a week with none is a gap.
 * The target is the mean of the days' own targets (none when no day had a revision).
 */
export function weeklyPoints(days: TrendDay[], metric: TrendMetric, unit: WeightUnit = "lb"): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (let start = days.length % 7; start + 7 <= days.length; start += 7) {
    const week = days.slice(start, start + 7).map((day) => dayValue(day, metric, unit));
    const valued = week.filter((v) => v.value !== null);
    const avg = mean(valued.map((v) => v.value as number));
    const target = mean(week.filter((v) => v.target !== null).map((v) => v.target as number));
    const round = metric === "weight" ? (n: number) => Math.round(n * 10) / 10 : Math.round;
    out.push({ date: days[start].date, end: days[start + 6].date,
      value: avg === null ? null : round(avg), target: target === null ? null : Math.round(target),
      partial: valued.some((v) => v.partial), days: valued.length, span: 7, training: false });
  }
  return out;
}

/** The mean of the last seven days that have a value; null with none. */
export function sevenDayMean(days: TrendDay[], metric: TrendMetric, unit: WeightUnit = "lb"): number | null {
  const values = days.slice(-7).map((day) => dayValue(day, metric, unit))
    .filter((v) => v.value !== null && !v.partial).map((v) => v.value as number);
  const avg = mean(values);
  return avg === null ? null : metric === "weight" ? Math.round(avg * 10) / 10 : Math.round(avg);
}

/**
 * Goal progress over the window: of the whole days that have both a value and a target, how many
 * met it. Calories count within 10 % of the target; protein and water count at or above it.
 * A partial day is never judged. Null when there is no day to judge (no target yet, or no data).
 */
export function goalProgress(points: TrendPoint[], metric: TrendMetric): { met: number; of: number } | null {
  if (metric !== "kcal" && metric !== "protein" && metric !== "water") return null;
  const judged = points.filter((p) => p.span === 1 && p.value !== null && p.target !== null && p.target > 0 && !p.partial);
  if (judged.length === 0) return null;
  const met = judged.filter((p) => metGoal(metric, p.value as number, p.target as number)).length;
  return { met, of: judged.length };
}

export function metGoal(metric: TrendMetric, value: number, target: number): boolean {
  if (metric === "kcal") return Math.abs(value - target) <= target * 0.1;
  return value >= target;
}

// ------------------------------------------------------------------ words

/** "1,840 kcal", "62 g", "6 cups", "7h 20m", "320 kcal", "154.2 lb". */
export function formatMetric(metric: TrendMetric, value: number,
  opts: { weightUnit?: WeightUnit; waterUnit?: WaterUnit } = {}): string {
  switch (metric) {
    case "kcal": case "activity": return `${Math.round(value).toLocaleString("en-US")} kcal`;
    case "protein": return `${Math.round(value)} g`;
    case "water": return formatWater(value, opts.waterUnit ?? "cups");
    case "sleep": {
      const minutes = Math.round(value);
      return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
    }
    case "weight": return `${Math.round(value * 10) / 10} ${opts.weightUnit ?? "lb"}`;
  }
}

/** "Tue", from an ISO date, independent of the phone's zone. */
export function weekdayShort(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

/** "Oct 6". */
export function monthDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
