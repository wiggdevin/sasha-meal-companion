/**
 * The Day card's day helpers (2026-10-01, docs/decisions/2026-10-01-liquid-day-card-rulings.md; the
 * Overview cockpit since the UI makeover, W2): the next meal, the week, the meal count and the one
 * next step. Pure. Every figure comes from the same resolved day the rest of Today shows; nothing
 * here invents a value for a day that was not logged.
 */
import { completionFor, mondayFor, shiftCalendarDay } from "@/lib/today/calendar";
import { dayHasPartialNutrition, resolveDay } from "@/lib/resolve";
import { illustrativeMealImage } from "@/lib/today/meal-art";
import type { ResolvedSlot, Store } from "@/lib/types";

export type NextMeal = {
  slot: ResolvedSlot["slot"];
  label: string;
  name: string;
  time: string;
  kcal: number;
  protein: number;
  /** The meal card's own illustrative photo, when its foods support one. */
  image: string | null;
};

/** "08:30" → minutes after midnight; an unreadable time sorts last. */
function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : Number.POSITIVE_INFINITY;
}

/**
 * The next planned meal that is not eaten yet, in clock order. On today a meal more than two hours
 * past its time gives way to a later one, so the pin points at what is still ahead; once every
 * later meal is eaten, the earliest one left is shown again rather than nothing.
 */
export function nextMeal(slots: ResolvedSlot[], nowMinutes: number | null): NextMeal | null {
  const open = slots
    .filter((slot) => slot.meal !== null && !slot.eaten)
    .sort((a, b) => minutes(a.time) - minutes(b.time));
  if (open.length === 0) return null;
  const ahead = nowMinutes === null ? open : open.filter((slot) => minutes(slot.time) >= nowMinutes - 120);
  const pick = ahead[0] ?? open[0];
  return {
    slot: pick.slot,
    label: pick.label,
    name: pick.meal?.name ?? pick.label,
    time: pick.time,
    kcal: Math.round(pick.macros.kcal),
    protein: Math.round(pick.macros.protein),
    image: illustrativeMealImage(pick.meal?.name ?? pick.label, pick.components),
  };
}

export type WeekDay = {
  date: string;
  /** One-letter weekday, Monday first. */
  letter: string;
  kcal: number;
  /** The day holds a partly measured recipe serving (#21): `kcal` is "at least". */
  partial?: boolean;
  target: number | null;
  status: ReturnType<typeof completionFor>;
  isToday: boolean;
  isViewed: boolean;
};

export type WeekSummary = {
  days: WeekDay[];
  /** Days in this week with every planned meal eaten. */
  onPlan: number;
  /** Days so far this week (today and earlier). */
  elapsed: number;
  /** Mean calories over the days that have any food logged, or null when none has. */
  averageKcal: number | null;
  /**
   * True when any day counted in `averageKcal` holds a partly measured recipe serving (#21,
   * `WeekDay.partial`): the average is then a lower bound ("at least"). False when none is, or
   * when there is no average. `weekSummary` always sets it; optional in the type, like
   * `WeekDay.partial`, so hand-built summaries (component fixtures) stay valid without it.
   */
  averagePartial?: boolean;
};

const LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * The viewed day's Monday-to-Sunday week, read from the local store. `store` and `eligibleIds` must
 * be the plan inputs Today resolves its own day with (the rule-review flag and the verified foods),
 * or a generated day can lose meals and read as all done with one eaten.
 */
export function weekSummary(store: Store, viewed: string, today: string,
  eligibleIds?: ReadonlySet<string>): WeekSummary {
  const monday = mondayFor(viewed);
  const days = LETTERS.map((letter, index): WeekDay => {
    const date = shiftCalendarDay(monday, index);
    const day = resolveDay(store, date, 0, eligibleIds);
    return {
      date, letter,
      kcal: Math.round(day.consumed.kcal),
      partial: dayHasPartialNutrition(day),
      target: day.targets ? Math.round(day.targets.kcal) : null,
      status: completionFor(day, today),
      isToday: date === today,
      isViewed: date === viewed,
    };
  });
  const past = days.filter((day) => day.date <= today);
  const logged = past.filter((day) => day.kcal > 0);
  return {
    days,
    onPlan: past.filter((day) => day.status === "all done").length,
    elapsed: past.length,
    averageKcal: logged.length > 0
      ? Math.round(logged.reduce((sum, day) => sum + day.kcal, 0) / logged.length) : null,
    averagePartial: logged.some((day) => day.partial),
  };
}

/** What the cockpit knows about the viewed day, for its one next step. */
export type NextStepInput = {
  when: "today" | "past" | "future";
  /** Planned meals on the viewed day. */
  planned: number;
  next: NextMeal | null;
  /** The day's water, or undefined while it has not been read. */
  water?: { cups: number; goal: number };
};

/**
 * The Overview cockpit's one "next step" line (UI makeover §11): the single most useful thing to do
 * on the viewed day, in plain words. It reads only what the face already shows, never tells anyone
 * to eat, and makes no health claim. The same inputs always give the same line.
 */
export function nextStep({ when, planned, next, water }: NextStepInput): string {
  if (planned === 0) {
    return when === "future" ? "Nothing is planned for this day yet." : "Nothing is planned. Tap + to log what you have.";
  }
  if (when === "future") return "Coming up. Tap a meal below to change it.";
  if (when === "past") {
    return next ? "Tick the meals you had so this day counts." : "Mark this day fully logged if nothing else went in.";
  }
  if (!next) return "Every meal is in. Mark the day fully logged when you're done.";
  if (water && water.goal > 0 && water.cups === 0) return "No water yet today. Tap the cup to log some.";
  return "Tick each meal once you've had it.";
}

