/**
 * Which slots a period plan's meal coverage means, by each slot's real clock (Phase 17 O4,
 * docs/specs/phase-17-meal-occasion.md, acceptance 10).
 *
 * The planner used to read "breakfast" as meal-1, "lunch" as meal-2, "dinner" as meal-3 and
 * "snack" as meal-4, whatever the schedule. On a day whose first meal is at 10:30 that put
 * "breakfast" into lunch. Now each date's slot clocks come from the account's schedule (the same
 * resolution Today uses: base layout → saved slot times → whole-day shift → that date's own time
 * edit), each slot's occasion is read off its clock (lib/meals/occasion.ts occasionAt), and a
 * meal word picks the slot whose occasion matches. When no slot on a date matches, the plan falls
 * back explicitly, and says so: the slot the old fixed mapping named, if the schedule has it, else
 * that meal is not planned that day.
 *
 * "meal-1" … "meal-6" still name a slot directly.
 *
 * Pure. No I/O.
 */

import { occasionAt, clockMinutes, type Occasion } from "@/lib/meals/occasion";
import { mealCountFor, resolveSlotTimes } from "@/lib/plan";
import type { ActiveTargetProfile, Settings } from "@/lib/types";
import type { MealWord } from "@/lib/recipes/occasion";

const MEAL_IDS = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"] as const;

/** The schedule the account keeps on the server (`user_settings`), as Today resolves it. */
export type PlanSchedule = {
  mealCount: number;
  slotTimes: Settings["slotTimes"];
  shiftMinutes: number;
};

export type CoverageLabel = { kind: "slot"; slotId: string } | { kind: "occasion"; occasion: MealWord };

/** The legacy fixed mapping, kept only as the explicit fallback. */
const LEGACY_SLOT: Readonly<Record<MealWord, string>> = {
  breakfast: "meal-1", lunch: "meal-2", dinner: "meal-3", snack: "meal-4",
};

/** The middle of each meal's usual time, to choose between two slots of the same occasion. */
const USUAL_MINUTES: Readonly<Record<MealWord, number>> = {
  breakfast: 8 * 60, lunch: 12 * 60 + 30, snack: 15 * 60 + 30, dinner: 18 * 60 + 30,
};

/** The meal count Today shows: the account's chosen count, else the one its targets imply. */
export function scheduleMealCount(mealsPerDay: unknown, trainingKcal: number | null | undefined): number {
  const chosen = typeof mealsPerDay === "number" ? mealsPerDay : null;
  const profile = typeof trainingKcal === "number" && Number.isFinite(trainingKcal)
    ? { training: { kcal: trainingKcal } } as ActiveTargetProfile : null;
  return mealCountFor({ mealsPerDay: chosen, activeTargetProfile: profile });
}

/** One coverage label, or null when it is neither a meal word nor a slot id. */
export function parseCoverage(label: string): CoverageLabel | null {
  const normalized = label.trim().toLowerCase();
  if (/^meal-[1-6]$/.test(normalized)) return { kind: "slot", slotId: normalized };
  if (normalized in LEGACY_SLOT) return { kind: "occasion", occasion: normalized as MealWord };
  return null;
}

export type SlotClock = { slotId: string; time: string; occasion: Occasion };

/**
 * Each slot's clock and occasion on one date: the schedule, then that date's own time edit
 * (`plan_days.item_overrides[slot].time`) when it is a readable clock.
 */
export function slotClocksFor(
  schedule: PlanSchedule, dayOverrides?: Readonly<Record<string, unknown>> | null,
): SlotClock[] {
  const times = resolveSlotTimes("rest", { slotTimes: schedule.slotTimes, shiftMinutes: schedule.shiftMinutes,
    mealsPerDay: schedule.mealCount });
  return times.map(({ slot, time }) => {
    const edit = dayOverrides?.[slot];
    const own = edit && typeof edit === "object" ? (edit as { time?: unknown }).time : undefined;
    const clock = typeof own === "string" && clockMinutes(own) !== null ? own : time;
    return { slotId: slot, time: clock, occasion: occasionAt(clock) };
  });
}

/** A meal word no slot on a date matched, and where the plan put it instead (null: nowhere). */
export type CoverageFallback = { localDate: string; occasion: MealWord; slotId: string | null };

/**
 * The slots one date's coverage means, in slot order, and any explicit fallbacks. Slots are
 * assigned one to one: a named slot ("meal-2") is taken first; then every meal word takes the free
 * slot whose clock is that meal, nearest its usual time; only then does a word with no match fall
 * back to its old fixed slot, and only when no other label took it. A word left with no slot is
 * reported as not planned. A meal word whose meal is a slot the coverage already names is that
 * slot ("meal-1" and "breakfast" at 08:00 are one meal).
 */
export function placeCoverage(
  labels: readonly CoverageLabel[], localDate: string, clocks: readonly SlotClock[],
): { slots: SlotClock[]; fallbacks: CoverageFallback[] } {
  const chosen = new Map<string, SlotClock>();
  const fallbacks: CoverageFallback[] = [];
  for (const label of labels) {
    if (label.kind !== "slot") continue;
    const slot = clocks.find((row) => row.slotId === label.slotId);
    if (slot) chosen.set(slot.slotId, slot);
  }
  const named = new Set(chosen.keys());
  const words = [...new Set(labels.flatMap((label) => label.kind === "occasion" ? [label.occasion] : []))];
  const unmatched: MealWord[] = [];
  for (const occasion of words) {
    const matching = clocks.filter((row) => row.occasion === occasion);
    if (matching.some((row) => named.has(row.slotId))) continue;
    const usual = USUAL_MINUTES[occasion];
    const match = matching.filter((row) => !chosen.has(row.slotId))
      .sort((a, b) => Math.abs((clockMinutes(a.time) ?? 0) - usual) - Math.abs((clockMinutes(b.time) ?? 0) - usual)
        || a.slotId.localeCompare(b.slotId))[0];
    if (match) chosen.set(match.slotId, match);
    else unmatched.push(occasion);
  }
  for (const occasion of unmatched) {
    const legacy = clocks.find((row) => row.slotId === LEGACY_SLOT[occasion] && !chosen.has(row.slotId)) ?? null;
    if (legacy) chosen.set(legacy.slotId, legacy);
    fallbacks.push({ localDate, occasion, slotId: legacy?.slotId ?? null });
  }
  const order = (id: string) => MEAL_IDS.indexOf(id as (typeof MEAL_IDS)[number]);
  return { slots: [...chosen.values()].sort((a, b) => order(a.slotId) - order(b.slotId)), fallbacks };
}

/**
 * A fallback stands only once a recipe actually fills its slot (review round 2, WARN 3): a
 * fallback slot the planner left unfilled, or did not plan at all (a saved edit, an eaten meal),
 * is reported as that meal not planned.
 */
export function confirmFallbacks(
  fallbacks: readonly CoverageFallback[], filled: ReadonlySet<string>,
): CoverageFallback[] {
  return fallbacks.map((row) => row.slotId && !filled.has(`${row.localDate}:${row.slotId}`)
    ? { ...row, slotId: null } : row);
}

const mealName = (slotId: string) => `Meal ${slotId.slice(5)}`;

/** One line per fallback kind, naming its dates, for the preview's informational issues. */
export function describeFallbacks(fallbacks: readonly CoverageFallback[]): string[] {
  const groups = new Map<string, { occasion: MealWord; slotId: string | null; dates: string[] }>();
  for (const row of fallbacks) {
    const key = `${row.occasion}:${row.slotId ?? ""}`;
    const group = groups.get(key) ?? { occasion: row.occasion, slotId: row.slotId, dates: [] };
    group.dates.push(row.localDate);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ occasion, slotId, dates }) => {
    const when = dates.join(", ");
    return slotId
      ? `No meal in your schedule falls at ${occasion} time on ${when}; ${occasion} is planned in ${mealName(slotId)} instead.`
      : `${occasion[0].toUpperCase()}${occasion.slice(1)} is not planned on ${when}: no free meal in your schedule falls at ${occasion} time.`;
  });
}
