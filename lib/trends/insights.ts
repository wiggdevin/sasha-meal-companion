/**
 * Plain-language insights for the "Your week" card (UI makeover §11, W4). Pure code over the
 * window's `TrendDay`s: no model call, no medical claim, nothing about what anyone should eat.
 *
 * Each insight states what the account's own days show and how many days it rests on. It appears
 * only when there are enough days on both sides of the comparison and the difference is large
 * enough to say plainly; otherwise it is left out, never softened into a guess. Only whole days
 * count for intake (a partial day, or today before it is marked fully logged, is left out).
 */
import { metGoal, type TrendDay } from "@/lib/trends/series";

export type InsightKind = "sleep_intake" | "protein_training" | "weekend_intake" | "active_intake";
export type Insight = { kind: InsightKind; text: string; days: number; strength: number };

/** Minimum days per side, and in all, before a comparison is shown. */
export const MIN_SIDE_DAYS = 3;
export const MIN_TOTAL_DAYS = 7;
/** A relative difference in calories below this is not worth a line. */
export const MIN_INTAKE_DIFF = 0.1;
/** A difference in protein hit rates below this (percentage points) is not worth a line. */
export const MIN_RATE_GAP = 0.25;
export const MAX_INSIGHTS = 3;

const wholeIntake = (day: TrendDay): day is TrendDay & { kcal: number } =>
  day.kcal !== null && !day.intakePartial && day.kcal > 0;

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const pct = (ratio: number) => `${Math.round(Math.abs(ratio) * 100)}%`;

/** Calories on two sides of a split, as one insight, or null when the data cannot say. */
function intakeSplit(kind: InsightKind, high: number[], low: number[],
  line: (more: boolean, diff: string, days: number) => string): Insight | null {
  const days = high.length + low.length;
  if (high.length < MIN_SIDE_DAYS || low.length < MIN_SIDE_DAYS || days < MIN_TOTAL_DAYS) return null;
  const ratio = mean(high) / mean(low) - 1;
  if (!Number.isFinite(ratio) || Math.abs(ratio) < MIN_INTAKE_DIFF) return null;
  return { kind, text: line(ratio > 0, pct(ratio), days), days, strength: Math.abs(ratio) };
}

/** Calories on days after shorter sleep than the account's own middle value, against longer. */
export function sleepIntake(days: TrendDay[]): Insight | null {
  const paired = days.filter((d) => wholeIntake(d) && d.sleepMin !== null && d.sleepMin > 0);
  if (paired.length < MIN_TOTAL_DAYS) return null;
  const mid = median(paired.map((d) => d.sleepMin as number));
  const short = paired.filter((d) => (d.sleepMin as number) < mid).map((d) => d.kcal as number);
  const long = paired.filter((d) => (d.sleepMin as number) > mid).map((d) => d.kcal as number);
  return intakeSplit("sleep_intake", short, long, (more, diff, n) =>
    `After shorter sleep you ate about ${diff} ${more ? "more" : "less"} (${n} days).`);
}

/** Calories on Saturday and Sunday against the weekdays. */
export function weekendIntake(days: TrendDay[]): Insight | null {
  const whole = days.filter(wholeIntake);
  const weekend = whole.filter((d) => d.weekday === 0 || d.weekday === 6).map((d) => d.kcal as number);
  const weekday = whole.filter((d) => d.weekday !== 0 && d.weekday !== 6).map((d) => d.kcal as number);
  return intakeSplit("weekend_intake", weekend, weekday, (more, diff, n) =>
    `On weekends you ate about ${diff} ${more ? "more" : "less"} than on weekdays (${n} days).`);
}

/** Calories on days with more active energy than the account's own middle value, against fewer. */
export function activeIntake(days: TrendDay[]): Insight | null {
  const paired = days.filter((d) => wholeIntake(d) && d.activeKcal !== null && !d.today);
  if (paired.length < MIN_TOTAL_DAYS) return null;
  const mid = median(paired.map((d) => d.activeKcal as number));
  const active = paired.filter((d) => (d.activeKcal as number) > mid).map((d) => d.kcal as number);
  const quiet = paired.filter((d) => (d.activeKcal as number) < mid).map((d) => d.kcal as number);
  return intakeSplit("active_intake", active, quiet, (more, diff, n) =>
    `On more active days you ate about ${diff} ${more ? "more" : "less"} (${n} days).`);
}

/** How often protein reached its target on training days against rest days. */
export function proteinTraining(days: TrendDay[]): Insight | null {
  const judged = days.filter((d) => d.protein !== null && !d.intakePartial
    && d.proteinTarget !== null && d.proteinTarget > 0);
  const training = judged.filter((d) => d.dayType !== "rest");
  const rest = judged.filter((d) => d.dayType === "rest");
  if (training.length < MIN_SIDE_DAYS || rest.length < MIN_SIDE_DAYS || judged.length < MIN_TOTAL_DAYS) return null;
  const hits = (list: TrendDay[]) => list.filter((d) => metGoal("protein", d.protein as number, d.proteinTarget as number)).length;
  const t = hits(training);
  const r = hits(rest);
  const gap = t / training.length - r / rest.length;
  if (Math.abs(gap) < MIN_RATE_GAP) return null;
  return { kind: "protein_training", days: judged.length, strength: Math.abs(gap),
    text: `Protein reached its target on ${t} of ${training.length} training days and ${r} of ${rest.length} rest days.` };
}

/** Up to three insights, the clearest first. */
export function insights(days: TrendDay[]): Insight[] {
  return [sleepIntake(days), proteinTraining(days), weekendIntake(days), activeIntake(days)]
    .filter((i): i is Insight => i !== null)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_INSIGHTS);
}
