/**
 * Deterministic meals built only from the current account's Eats and target revision.
 *
 * Each slot gets the best coherent plate for its occasion (lib/meals, Phase 17 O1): the slot's
 * clock picks the occasion and template, the curated table picks anchor and sides, every item is
 * sized inside its portion band, and the day prefers distinct anchors; a protein repeats when that
 * scores better, never in neighbouring slots unless the other choice is an empty slot (D5,
 * amended). A slot nothing coherent fits is left empty with a shortage reason naming the missing
 * part.
 */
import type { Food } from "@/lib/foods";
import { planDay, type DayPlan, type QuickRanking } from "@/lib/meals/day";
import { plateMinutes, QUICK_MINUTES } from "@/lib/plan/prep-minutes";
import type { OccasionOverrides } from "@/lib/meals/occasion";
import type { FocusRanking } from "@/lib/meals/plate";
import { evidenceKey, type MealEvidence } from "@/lib/meals/snapshot";
import { cuisineKey, cuisineRanking, type CuisineRanking } from "@/lib/meals/cuisine";
import { plateChips, type OpenWorldInputs } from "@/lib/meals/open-world";
import type { Macros, Meal, SlotId } from "@/lib/types";

export { usableForGeneration } from "@/lib/meals/pool";

export type LayoutSlot = { id: SlotId; target: Macros; clock?: string | null };
/** An active shopping focus for the planned date (lib/shopping/focus.ts `focusRankingOn`). */
export type LayoutFocus = FocusRanking & { id: string };

export type LayoutResult = {
  meals: { slot: SlotId; meal: Meal }[];
  shortages: DayPlan["shortages"];
  misses: DayPlan["misses"];
};

/** A061: the "Quick meals" mark's rule, the Plan sheet's "Ready in 15 min" cut. */
const QUICK_PLATES: QuickRanking = { maxMinutes: QUICK_MINUTES, minutesOf: plateMinutes };

/** Today renders the same day several times (cards, notice, today's totals): plan it once. */
const MEMO_SIZE = 12;
const memo = new Map<string, DayPlan>();

function memoKey(date: string, slots: readonly LayoutSlot[], foods: Record<string, Food>,
  overrides?: OccasionOverrides, evidence?: MealEvidence | null, open?: OpenWorldInputs,
  focus?: LayoutFocus, cuisine?: CuisineRanking, quick?: boolean): string {
  const foodPart = Object.values(foods).map((food) => [food.id, food.name, food.role, food.status,
    food.unit, food.perUnit.protein, food.perUnit.carbs, food.perUnit.fat].join("|")).sort().join(";");
  // A closed account's key is exactly main's; an open one adds its snapshot's identity, and an
  // active shopping focus its own (end and the keys that count that day).
  return JSON.stringify([date, slots, overrides ?? null, foodPart, evidenceKey(evidence),
    ...(open ? [open.key] : []), ...(focus ? [`focus:${focus.id}`] : []),
    ...(cuisine ? [`cuisine:${cuisineKey(cuisine)}`] : []), ...(quick ? ["quick"] : [])]);
}

/**
 * The generator with its shortage reasons: one computation for the cards and the notice.
 * `evidence`: the account's snapshot evidence (lib/meals/snapshot.ts); see `planDay`.
 *
 * `open` (Phase 18 W8): an open food-world account's admitted pool, taste values and search
 * (lib/meals/open-world.ts). The caller passes `open.foods` as `foods` and `open.evidence` as
 * `evidence`; each generated meal then carries its reason chips. Absent: main's generator.
 *
 * `focus` (Phase 18 W11, D7): the account's active shopping focus for `date`; every slot then
 * takes the highest list/pantry coverage that fits (lib/meals/day.ts). Absent: unchanged.
 *
 * `cuisines` (onb3): the account's stored `user_settings.cuisines`; a stated cuisine raises plates
 * of its foods (lib/meals/cuisine.ts). None stated: unchanged.
 *
 * `quick` (A061): the date carries the "Quick meals" mark (`StoredDay.floorDay`); each slot then
 * takes a plate ready in 15 minutes (lib/plan/prep-minutes.ts) when one fits it, else the plate it
 * would have had. Absent or false: unchanged.
 */
export function planMealsForDay(
  date: string, slots: readonly LayoutSlot[], foods: Record<string, Food>,
  overrides?: OccasionOverrides, evidence?: MealEvidence | null, open?: OpenWorldInputs,
  focus?: LayoutFocus, cuisines?: readonly string[] | null, quick?: boolean,
): LayoutResult {
  const cuisine = cuisineRanking(cuisines);
  const key = memoKey(date, slots, foods, overrides, evidence, open, focus, cuisine, quick);
  let plan = memo.get(key);
  if (!plan) {
    plan = quick ? planDay(date, slots, foods, overrides, evidence, open?.taste, open?.ranking, focus, cuisine,
      QUICK_PLATES)
      : cuisine ? planDay(date, slots, foods, overrides, evidence, open?.taste, open?.ranking, focus, cuisine)
      : open ? planDay(date, slots, foods, overrides, evidence, open.taste, open.ranking, focus)
        : focus ? planDay(date, slots, foods, overrides, evidence, undefined, undefined, focus)
          : planDay(date, slots, foods, overrides, evidence);
    if (memo.size >= MEMO_SIZE) memo.delete(memo.keys().next().value as string);
    memo.set(key, plan);
  }
  // Fresh objects every call: a caller may edit what it is handed, never the memo.
  return {
    meals: plan.plates.map(({ slot, plate }) => {
      const reasons = open ? plateChips(plate, open.chips) : [];
      return { slot, meal: {
        id: `suggested:${date}:${slot}`, name: plate.name, slot,
        components: plate.components.map((part) => ({ ...part, macros: { ...part.macros } })),
        macros: { ...plate.macros }, prepMinutes: 0, tags: [], ...(reasons.length ? { reasons } : {}),
      } satisfies Meal };
    }),
    shortages: plan.shortages.map(({ slot, shortage }) => ({ slot,
      shortage: { missing: [...shortage.missing], reason: shortage.reason } })),
    misses: plan.misses.map((miss) => ({ ...miss })),
  };
}

/** The generated meals only. A slot's optional `clock` ("07:30") sets its occasion. */
export function layoutMealsForDay(
  date: string, slots: readonly LayoutSlot[], foods: Record<string, Food>, evidence?: MealEvidence | null,
): { slot: SlotId; meal: Meal }[] {
  return planMealsForDay(date, slots, foods, undefined, evidence).meals;
}
