/**
 * The Day card's board (2026-10-01, docs/decisions/2026-10-01-liquid-day-card-rulings.md): pure
 * helpers for its pins. Every figure comes from the same resolved day the rest of Today shows;
 * nothing here invents a value for a day that was not logged.
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

/** The small line glyph a tip wears on the tile and in its full view (components/today/tips/TipGlyph.tsx). */
export type TipGlyph = "overview" | "calendar" | "time" | "gesture" | "water" | "coach";

/** The looping demonstration in a tip's full view (components/today/tips/TipDemo.tsx). */
export type TipDemoKey = "orb" | "scrub" | "month" | "hold-drag" | "swipe" | "water";

/**
 * What the board already knows about the viewed day, for ordering tips (2026-10-03). Every field
 * comes from data DayBoard is given; nothing here is fetched for the tips.
 */
export type TipContext = {
  /** The viewed day and today, ISO dates. */
  date: string;
  today: string;
  /** The viewed day's water, or null while it has not been read. */
  water: { cups: number; goal: number } | null;
  /** Planned meals on the viewed day. */
  planned: number;
  /** True while a planned meal on the viewed day is not ticked as eaten. */
  open: boolean;
  /** When this account's local store was first written (ISO), or null when unknown. */
  firstOpenedAt: string | null;
  /** The viewed day is a training day. */
  training: boolean;
};

export type BoardTip = {
  id: string;
  /** The one-line summary on the tile. With a title it carries on from it; without one it stands alone. */
  text: string;
  /** "app" tips explain the app; "coach" tips come from the coach's nutritionist. */
  source: "app" | "coach";
  /** The short headline, a few words. */
  title?: string;
  glyph?: TipGlyph;
  /** The full view's steps, in order. A tip without them shows its summary there. */
  steps?: string[];
  /** The full view's demonstration; a tip without one shows its glyph large instead. */
  demo?: TipDemoKey;
  /** How much this tip matters now: 0 (or none) is "not especially", higher leads. Pure, and it
   *  reads only the context it is given. */
  relevance?: (context: TipContext) => number;
};

/** Days since the account's store was first written, while it still counts as new. */
const NEW_ACCOUNT_DAYS = 7;

function isoDayNumber(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

/** True during the account's first week, counted from its first open to today. */
export function isNewAccount(context: Pick<TipContext, "firstOpenedAt" | "today">): boolean {
  if (!context.firstOpenedAt) return false;
  const first = isoDayNumber(context.firstOpenedAt);
  const today = isoDayNumber(context.today);
  if (first === null || today === null) return false;
  const age = today - first;
  return age >= 0 && age < NEW_ACCOUNT_DAYS;
}

/** How to use Today, written plainly: a short headline and one line for the tile, then the steps
 *  and a demonstration for the full view. The nutritionist's own tips join this list later as
 *  `source: "coach"`; the board never writes nutrition advice of its own. */
export const APP_TIPS = [
  { id: "orb", source: "app", glyph: "overview", demo: "orb", title: "Open your day",
    text: "See food, water, activity and sleep at once.",
    steps: [
      "Tap the eye in the switch at the top of the Day card.",
      "Calories, protein, carbs and fat join water, activity and recovery on one ring.",
      "Tap any of them to see its detail.",
      "Tap the orb in the middle, or press Escape, to fold it back.",
    ],
    relevance: (c) => (isNewAccount(c) ? 3 : 0) },
  { id: "scrub", source: "app", glyph: "calendar", demo: "scrub", title: "Slide the week",
    text: "Change the day. A quick flick jumps a whole week.",
    steps: [
      "Drag the week strip left or right. The day under the olive lens is the day you see.",
      "Flick it quickly to move a whole week at once.",
      "Today's date stays red, so the way back is easy to find.",
      "With a keyboard, the arrow keys move a day and Page Up or Page Down a week.",
    ],
    relevance: (c) => (isNewAccount(c) ? 2 : 0) },
  { id: "month", source: "app", glyph: "calendar", demo: "month", title: "Double-tap the week",
    text: "The next four weeks open below it.",
    steps: [
      "Double-tap the week strip, or tap the date above it.",
      "Four weeks open below the week. Tap any day to go to it.",
      "Double-tap again to fold them away.",
    ],
    relevance: (c) => (isNewAccount(c) ? 1 : 0) },
  { id: "time", source: "app", glyph: "time", demo: "hold-drag", title: "Hold a meal card",
    text: "Then drag up or down to move its time.",
    steps: [
      "Press and hold a meal card until it lifts.",
      "Keep holding and drag up for earlier or down for later. The time moves in 15-minute steps.",
      "Let go to save the new time.",
      "Moved it by mistake? Hold it and drag it back.",
    ],
    relevance: (c) => (c.training && c.open && c.date >= c.today ? 3 : 0) },
  { id: "swipe", source: "app", glyph: "gesture", demo: "swipe", title: "Swipe a meal left",
    text: "Clear it, or remove it from the day.",
    steps: [
      "Swipe a meal card to the left. Clear shows first, and the card stops there.",
      "Tap Clear to empty the slot.",
      "Swipe farther to show Delete. Past the second stop, letting go removes the meal from the day.",
      "Swipe back to the right to leave it as it was.",
    ],
    relevance: (c) => (c.open && c.date < c.today ? 4 : 0) },
  { id: "water", source: "app", glyph: "water", demo: "water", title: "Add water fast",
    text: "Tap the tile for a cup. Hold and slide to set the day's total.",
    steps: [
      "Tap the water tile to add one step in your unit: a cup, 8 oz or 237 ml.",
      "Hold it for a moment and a bar opens above the tile.",
      "Slide right to add more, faster the farther you go. Slide left to take some back.",
      "Let go to log it once. Escape, or letting go at zero, changes nothing.",
    ],
    relevance: (c) => (c.date === c.today && c.water !== null && c.water.cups === 0 ? 5 : 0) },
] satisfies (BoardTip & Required<Pick<BoardTip, "title" | "glyph" | "steps" | "demo">>)[];

/** Coach tips first, then the app's, without repeats. */
export function boardTips(coach: BoardTip[] = []): BoardTip[] {
  const seen = new Set<string>();
  return [...coach, ...APP_TIPS].filter((tip) => (seen.has(tip.id) ? false : (seen.add(tip.id), true)));
}

function relevanceOf(tip: BoardTip, context: TipContext): number {
  const score = tip.relevance?.(context) ?? 0;
  return Number.isFinite(score) && score > 0 ? score : 0;
}

/**
 * The board's tips in the order the tile shows them (2026-10-03):
 * 1. tips that matter now, most pressing first (ties keep their list order);
 * 2. the coach's other tips, in list order;
 * 3. the app's other tips, in list order, starting from the day's tip so the board has something
 *    new each morning (`tipIndexFor`).
 * The same inputs always give the same order.
 */
export function orderTips(tips: BoardTip[], context: TipContext): BoardTip[] {
  const scored = tips.map((tip, index) => ({ tip, index, score: relevanceOf(tip, context) }));
  const lead = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const coach = scored.filter((s) => s.score === 0 && s.tip.source === "coach");
  const app = scored.filter((s) => s.score === 0 && s.tip.source !== "coach");
  const start = tipIndexFor(context.date, app.length);
  const rotated = [...app.slice(start), ...app.slice(0, start)];
  return [...lead, ...coach, ...rotated].map((s) => s.tip);
}

/** A day of the month, the tips rotate once a day so the board has something new each morning. */
export function tipIndexFor(date: string, count: number): number {
  if (count <= 0) return 0;
  const day = Number(date.slice(-2)) || 0;
  return day % count;
}
