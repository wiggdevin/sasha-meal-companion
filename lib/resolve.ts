/**
 * Store + date → the ResolvedDay the UI renders and the MCP server reports.
 * Pure; runs on the phone and on the server with the same result.
 */

import { getMealOptions, SLOT_LABELS } from "./meals";
import {
  consumedSnapshot, eatenEstimateMeal, eatenPlanSnapshot, eatenPlanSnapshotIfUnlogged,
  slotHasOwnLog, undescribedEatenSlots,
} from "@/lib/plan/eaten-estimate";
import { planMealsForDay, type LayoutResult } from "./foods/layout-plan";
import { SUGGESTIONS_NEED_CONNECTION } from "./meals/snapshot";
import { generationPool, poolAnchors } from "./meals/pool";
import type { Food } from "./foods";
import type { Shortage } from "./meals/plate";
import type { NutrientCode } from "./nutrients/codes";
import type { Snapshot } from "./nutrients/snapshot";
import { totalsFor, type NutrientTotal } from "./nutrients/totals";
import { resolveSlotTimes, shiftTime } from "./plan";
import { BASE_SLOT_TIMES } from "./plan-legacy";
import { rotationIndex } from "./rotation";
import { scaleComponents, scaleProteinComponents } from "./scaling";
import type {
  DayType,
  FoodComponent,
  Macros,
  Meal,
  ResolvedDay,
  ResolvedSlot,
  RuleMark,
  SlotId,
  SlotOverride,
  Store,
} from "./types";
import { componentsForSlot } from "./plan/slot-override";
import {
  componentRuleMark, currentEligibleView, focusOf, mealEvidenceOf, openWorldOf, recipeRuleMark, worstRuleMark,
  type EligibleView,
} from "./foods/rule-marks";
import { livePool, type OpenWorldInputs } from "./meals/open-world";
import { entryMacros } from "./plan/entry-macros";
import {
  frozenEatenShare, plannedSlotIds, ratiosFor, scaledSlotTarget, sumMacros, zeroMacros, type Ratios,
} from "./plan/slot-share";

export { entryMacros, measuredItems, snapshotMacros } from "./plan/entry-macros";
export {
  frozenEatenShare, loggedOutsideSlots, planningSlotTarget, plannedSlotIds, ratiosFor, scaledSlotTarget, type Ratios,
} from "./plan/slot-share";


/**
 * Meals are authored against the slot library. Active revision ratios resize the library.
 */
export function scaleMealComponents(meal: Meal, r: Ratios): FoodComponent[] {
  const carbPass = scaleComponents(meal.components, r.carbRatio);
  const fatPass = scaleComponents(meal.components, r.fatRatio);
  const proteinPass = scaleProteinComponents(meal.components, r.proteinRatio);
  return meal.components.map((component, i) => {
    if (component.role === "carb") return carbPass[i];
    if (component.role === "fat") return fatPass[i];
    if (component.role === "protein") return proteinPass[i];
    return component;
  });
}


const HISTORICAL_RITUAL_IDS: SlotId[] = ["coffee", "pouches-pre", "post-refuel", "hot-chocolate"];
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Only user-authored or logged historical rows are shown; no ritual is generated for a new date. */
function savedRitualIds(store: Store, date: string): SlotId[] {
  const day = store.days[date];
  return HISTORICAL_RITUAL_IDS.filter((id) => (!day?.itemOverrides?.[id]?.removed || !!day?.eaten?.[id])
    && (day?.eaten?.[id] || day?.itemOverrides?.[id] || day?.swaps?.[id] || day?.notes?.[id]));
}

function historicalOption(dayType: DayType, slot: SlotId, date: string, swapId?: string): Meal | null {
  const fallbackType: DayType = slot === "pouches-pre" ? "training-10"
    : slot === "post-refuel" ? "training-7-fasted" : "rest";
  const pool = getMealOptions(dayType, slot).length
    ? getMealOptions(dayType, slot) : getMealOptions(fallbackType, slot);
  if (swapId) return pool.find((meal) => meal.id === swapId) ?? null;
  return pool[rotationIndex(date, pool.length, slot)] ?? null;
}

/** An old client might have saved an added meal without its time; keep the card usable. */
function timesForLayout(ids: SlotId[], store: Store, date: string, dayType: DayType): Map<SlotId, string> {
  const scheduled = new Map(resolveSlotTimes(dayType, store.settings)
    .map(({ slot, time }) => [slot, time]));
  const times = new Map<SlotId, string>();
  let previous = "";
  for (const id of ids) {
    const override = store.days[date]?.itemOverrides?.[id]?.time;
    const later = previous ? shiftTime(previous, 150) : "12:00";
    const time = override && CLOCK_TIME.test(override) ? override
      : scheduled.get(id) ?? (later > "21:30" ? "21:30" : later);
    times.set(id, time);
    previous = time;
  }
  return times;
}


/**
 * Every nutrient logged on this day, with the item counts DayNutrients needs for coverage.
 *
 * Coverage counts EVERY logged item, measured or not — the server's `daily_totals` definition
 * (items_total is every log_item that day). Filtering to measured items first made one measured
 * and one empty item read 1.0 here and 0.5 on the server (calculation audit #22). The legacy macro
 * fallback for unmeasured items lives in `snapshotMacros`, not here.
 */
export function dayNutrientTotals(day: ResolvedDay): Map<NutrientCode, NutrientTotal> {
  return totalsFor(day.extras.flatMap((e) => e.items ?? [])
    .map((item) => ({ snapshot: (item.snapshot ?? {}) as Snapshot })));
}

/**
 * True when any of the day's logged entries is a partly measured recipe serving (#21): the day's
 * kcal and macros then include a partial count, which item coverage cannot show — the recipe's
 * snapshot carries numbers, just not all of them. Render the totals as "at least".
 */
export function dayHasPartialNutrition(day: ResolvedDay): boolean {
  return day.extras.some((entry) => entry.nutritionPartial === true);
}

/** Share the exact generated-slot pool with the Today shortage notice. Only open slots are
 *  generated: an eaten slot, described or not, is never rebuilt (lib/plan/eaten-estimate.ts). */
function generationInputs(store: Store, date: string, dayType: DayType, targets: Macros | null,
  layoutIds: SlotId[], eligibleFoodIds?: ReadonlySet<string>) {
  const stored = store.days[date];
  const undescribedEaten = undescribedEatenSlots(stored, layoutIds);
  // F3: a set verified under older rules is never reused; a food off Eats leaves it at once.
  const view = currentEligibleView(store.foods, store.settings, eligibleFoodIds);
  const generated = targets && store.settings.ruleReviewReady === true && view
    ? layoutIds.flatMap((id) => {
    const target = scaledSlotTarget(store, date, dayType, id);
    return target ? [{ id, target }] : [];
  }) : [];
  const fixedProteins = new Set(layoutIds.filter((id) =>
    !generated.some((entry) => entry.id === id))
    .flatMap((id) => stored?.itemOverrides?.[id]?.components ?? [])
    .filter((part) => part.role === "protein").map((part) => part.name.toLowerCase()));
  // Phase 18 W8: an open account generates from its admitted pool (Favored and universe foods, as
  // this device stands now); a closed one from its verified Eats, exactly as before.
  const open: OpenWorldInputs | undefined = view ? openWorldOf(eligibleFoodIds) : undefined;
  const source = open ? Object.entries(livePool(open, store.foods))
    : Object.entries(store.foods).filter(([id]) => view?.ids.has(id));
  const eligibleFoods = Object.fromEntries(source
    .filter(([, food]) => food.role !== "protein" || !fixedProteins.has(food.name.toLowerCase()))) as Record<string, Food>;
  return { generated, eligibleFoods, undescribedEaten, view, open };
}

/** The generator's own run for a day: its meals and, per slot, why a slot stayed empty. */
function generatedPlan(store: Store, date: string, eligibleFoodIds?: ReadonlySet<string>):
  { plan: LayoutResult; required: number; pool: Record<string, Food> } | null {
  if (!eligibleFoodIds || store.settings.ruleReviewReady !== true) return null;
  const { dayType, targets } = ratiosFor(store, date);
  if (!targets) return null;
  const layoutIds = plannedSlotIds(store, date, dayType);
  const times = timesForLayout(layoutIds, store, date, dayType);
  const pool = generationInputs(store, date, dayType, targets, layoutIds, eligibleFoodIds);
  if (!pool.view) return null;
  const slots = pool.generated.map((slot) => ({ ...slot, clock: times.get(slot.id) ?? null }));
  return { plan: planMealsForDay(date, slots, pool.eligibleFoods, undefined,
    mealEvidenceOf(eligibleFoodIds), pool.open, focusOf(eligibleFoodIds, date), store.settings.cuisines),
    required: slots.length,
    pool: pool.eligibleFoods };
}

/**
 * Proteins this account's verified Eats offer for the generated slots, from the generator's own
 * run (D5, amended): a protein may repeat, so `required` exceeds `available` only when the
 * generator really left a slot short of a protein.
 */
export function generatedProteinAvailabilityForDay(store: Store, date: string,
  eligibleFoodIds?: ReadonlySet<string>): { available: number; required: number } | null {
  return generatedNotesForDay(store, date, eligibleFoodIds)?.proteins ?? null;
}

/** Why each generated slot that stayed empty is empty ("No breakfast starch or fruit fits yet — try another food"). */
export function generatedShortagesForDay(store: Store, date: string,
  eligibleFoodIds?: ReadonlySet<string>): Partial<Record<SlotId, Shortage>> | null {
  return generatedNotesForDay(store, date, eligibleFoodIds)?.shortages ?? null;
}

/** Generated slots whose plate still misses its target inside usual portions, with the reason. */
export function generatedMissesForDay(store: Store, date: string,
  eligibleFoodIds?: ReadonlySet<string>): Partial<Record<SlotId, string>> | null {
  return generatedNotesForDay(store, date, eligibleFoodIds)?.misses ?? null;
}

/**
 * The three readings above from one generator run, for a caller (Today) that shows them all: the
 * protein availability, each empty slot's shortage and each under-target plate's reason.
 */
export function generatedNotesForDay(store: Store, date: string,
  eligibleFoodIds?: ReadonlySet<string>): {
    proteins: { available: number; required: number };
    shortages: Partial<Record<SlotId, Shortage>>;
    misses: Partial<Record<SlotId, string>>;
  } | null {
  const run = generatedPlan(store, date, eligibleFoodIds);
  if (!run) return null;
  // The same nutrition guard and one-per-name rule as the generator.
  const available = poolAnchors(generationPool(run.pool)).length;
  // "Suggestions need a connection" suppresses every plate: the day is short, not protein-complete.
  const short = run.plan.shortages.some(({ shortage }) => shortage.missing.includes("anchor")
    || shortage.reason === SUGGESTIONS_NEED_CONNECTION);
  return {
    proteins: { available, required: short ? run.required : Math.min(run.required, available) },
    shortages: Object.fromEntries(run.plan.shortages.map(({ slot, shortage }) => [slot, shortage])),
    misses: Object.fromEntries(run.plan.misses.map(({ slot, reason }) => [slot, reason])),
  };
}

/**
 * F1/F2 (2026-10-05): every saved, uneaten line is judged against the CURRENT rules on read. A
 * generated plate was built from the current verified view, so it is clear by construction. A
 * `recipe:` override is judged by `recipeRuleMark` only (its ingredients against live Food status,
 * then the server's same-epoch verdict); it is never judged by its title.
 */
function savedRuleMarks(store: Store, override: SlotOverride | undefined, generated: boolean,
  components: FoodComponent[], view: EligibleView | undefined, admitted?: readonly Food[]): (RuleMark | null)[] {
  if (generated) return components.map(() => null);
  if (override?.baseMealId?.startsWith("recipe:")) {
    const mark = recipeRuleMark(override, store.foods, view);
    return components.map(() => mark);
  }
  return components.map((component) => componentRuleMark(component, store.foods, view, admitted));
}

/** Water comes from the caller's water_log read; retired StoredDay.waterMl is not used. */
export function resolveDay(store: Store, date: string, waterCups = 0,
  eligibleFoodIds?: ReadonlySet<string>): ResolvedDay {
  const stored = store.days[date];
  const { dayType, targets } = ratiosFor(store, date);
  const isFloorDay = stored?.floorDay ?? false;
  const layoutIds = plannedSlotIds(store, date, dayType);
  const layoutTimes = timesForLayout(layoutIds, store, date, dayType);
  const { generated, eligibleFoods, undescribedEaten, view, open } = generationInputs(store, date, dayType,
    targets, layoutIds, eligibleFoodIds);
  const rotated = planMealsForDay(date, generated.map((slot) => ({
    ...slot, clock: layoutTimes.get(slot.id) ?? null })), eligibleFoods, undefined,
    mealEvidenceOf(eligibleFoodIds), open, focusOf(eligibleFoodIds, date), store.settings.cuisines).meals;
  const rotationBySlot = new Map(rotated.map((entry) => [entry.slot, entry.meal]));
  // W8: an open account's saved lines may name admitted universe foods (a swapped-in plate).
  const admittedFoods = open ? Object.values(livePool(open, store.foods)) : undefined;
  const slots: ResolvedSlot[] = [...layoutIds, ...savedRitualIds(store, date)].map((slotId) => {
      const historical = HISTORICAL_RITUAL_IDS.includes(slotId);
      const historicalMeal = historical && (stored?.eaten?.[slotId] || stored?.swaps?.[slotId])
        ? historicalOption(dayType, slotId, date, stored?.swaps?.[slotId]) : null;
      const baseMeal = rotationBySlot.get(slotId) ?? historicalMeal;
      const override = stored?.itemOverrides?.[slotId];
      const planned = baseMeal?.components ?? [];
      // The logged shell beats a recipe snapshot: the log is then the only record.
      const consumed = consumedSnapshot(stored, slotId);
      // A time-edit's followPlan snapshot counts only while no log is filed under the slot; once
      // one is, the log is the record and the slot is zero, not the snapshot plus the log
      // (2026-10-05 audit, MAJOR 4).
      const planSnapshot = eatenPlanSnapshot(stored, slotId);
      const components = consumed?.components ?? eatenPlanSnapshotIfUnlogged(stored, slotId)
        ?? (planSnapshot ? [] : componentsForSlot(planned, override));
      const meal = consumed ? {
        id: consumed.baseMealId, name: consumed.title, slot: slotId, prepMinutes: 0,
        tags: [], components, macros: sumMacros(components),
      } satisfies Meal : override?.cleared ? null // A food-less followPlan shell describes nothing:
        : override && !(override.followPlan && !baseMeal && !components.length) ? {
        ...(baseMeal ?? {
          id: override.baseMealId ?? `plan:${slotId}`,
          name: SLOT_LABELS[slotId], slot: slotId, prepMinutes: 0, tags: [],
        }),
        name: override.title ?? baseMeal?.name ?? SLOT_LABELS[slotId],
        components, macros: sumMacros(components),
      } satisfies Meal : baseMeal ?? null;
      // An eaten slot that nothing describes (no snapshot, no saved edit; a time-only followPlan
      // shell describes nothing either) is frozen: it shows its frozen share as an estimate, or
      // "counted in your log" when a log is filed under it (lib/plan/eaten-estimate.ts).
      // A saved historical ritual with nothing stored to describe it (its library meal is a planned
      // choice: rotation or a swap id) takes the same logged shell once a log is filed under it,
      // so the log counts once, not beside the library meal (Phase 19 R1). Without a log it keeps
      // its library display.
      const loggedRitual = historical && slotHasOwnLog(stored, slotId)
        && undescribedEatenSlots(stored, [slotId]).has(slotId);
      // A ticked slot whose followPlan snapshot a log suppressed is the same logged shell: the
      // log is the record and the card stays ticked, not an unticked empty slot (audit A064).
      const loggedSnapshot = !consumed && !!planSnapshot && slotHasOwnLog(stored, slotId);
      const estimate = undescribedEaten.has(slotId)
        ? eatenEstimateMeal(date, slotId, frozenEatenShare(store, date, dayType, slotId), stored)
        : loggedRitual || loggedSnapshot ? eatenEstimateMeal(date, slotId, undefined, stored) : null;
      const shown = estimate ?? meal;
      const eatenAt = shown ? stored?.eaten?.[slotId] : undefined;
      const historicalBase = BASE_SLOT_TIMES[dayType][slotId]
        ?? BASE_SLOT_TIMES.rest[slotId]
        ?? BASE_SLOT_TIMES["training-10"][slotId]
        ?? BASE_SLOT_TIMES["training-7-fasted"][slotId] ?? "12:00";
      const historicalTime = store.settings.slotTimes[slotId] ?? historicalBase;
      const time = layoutTimes.get(slotId) ?? (override?.time && CLOCK_TIME.test(override.time)
        ? override.time : shiftTime(historicalTime, store.settings.shiftMinutes));
      const shownComponents = estimate ? [] : components;
      // Eaten content is history and is never re-judged; an empty or cleared slot has nothing to mark.
      // A recipe: override is never a generated plate, even with followPlan set (round 3 WARN 5).
      const fromRotation = !consumed && !planSnapshot && rotationBySlot.has(slotId)
        && (!override || (!!override.followPlan && !override.baseMealId?.startsWith("recipe:")));
      const componentRuleMarks = eatenAt || !shown ? shownComponents.map(() => null)
        : savedRuleMarks(store, override, fromRotation, shownComponents, view, admittedFoods);
      return {
        slot: slotId,
        time,
        label: SLOT_LABELS[slotId],
        meal: shown,
        components: shownComponents,
        macros: estimate ? estimate.macros : meal ? sumMacros(components) : zeroMacros(),
        eaten: !!eatenAt,
        eatenAt,
        note: stored?.notes?.[slotId],
        // A shown recipe: override with no lines still carries its recipe verdict (round 4 WARN 4).
        ruleMark: !eatenAt && shown && shownComponents.length === 0 && !fromRotation
          && override?.baseMealId?.startsWith("recipe:")
          ? recipeRuleMark(override, store.foods, view) : worstRuleMark(componentRuleMarks),
        componentRuleMarks,
      };
    });

  slots.sort((a, b) => a.time.localeCompare(b.time));

  const extras = stored?.extras ?? [];
  const add = (acc: Macros, m: Macros): Macros => ({
    protein: acc.protein + m.protein,
    carbs: acc.carbs + m.carbs,
    fat: acc.fat + m.fat,
    kcal: acc.kcal + m.kcal,
  });
  const fromSlots = slots.filter((s) => s.eaten).reduce((acc, s) => add(acc, s.macros), { protein: 0, carbs: 0, fat: 0, kcal: 0 });
  const raw = extras.reduce((acc, e) => add(acc, entryMacros(e)), fromSlots);
  const consumed: Macros = {
    protein: Math.round(raw.protein),
    carbs: Math.round(raw.carbs),
    fat: Math.round(raw.fat),
    kcal: Math.round(raw.kcal),
  };

  return {
    date,
    dayType,
    isFloorDay,
    targets,
    slots,
    extras,
    consumed,
    waterCups,
    gut: stored?.gut,
    weightLb: stored?.weightLb,
  };
}
