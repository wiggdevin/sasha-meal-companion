/**
 * How one day's target is split across its meal slots. Pure; the phone and the server run it on
 * the same store and get the same numbers. Split out of lib/resolve.ts (400-line cap), which
 * re-exports every name here.
 *
 * The day's target first pays for what is already fixed: a saved meal, an eaten recipe snapshot, a
 * cleared (skipped) slot at zero, every eaten slot (lib/plan/eaten-estimate.ts), and every logged
 * entry, once. The open slots share the rest evenly (remainingPool), every macro from the same
 * pool. So skipping a meal gives its share to the open meals, and eating more shrinks them. An
 * eaten slot never takes part: what it holds was settled when it was ticked.
 */

import { SLOT_TARGETS } from "@/lib/meals";
import { slotListFor } from "@/lib/plan";
import { SLOT_ORDER } from "@/lib/plan-legacy";
import { resolveTargets, targetDayType } from "@/lib/targets";
import type { DayType, FoodComponent, Macros, SlotId, StoredDay, Store } from "@/lib/types";
import {
  consumedSnapshot, eatenPlanSnapshotIfUnlogged, slotHasOwnLog, undescribedEatenSlots,
} from "@/lib/plan/eaten-estimate";
import { entryMacros } from "@/lib/plan/entry-macros";
import { sameFoodComponents } from "@/lib/plan/same-components";

export type Ratios = { carbRatio: number; fatRatio: number; proteinRatio: number };

const MEAL_IDS: SlotId[] = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"];

export function zeroMacros(): Macros {
  return { kcal: 0, protein: 0, carbs: 0, fat: 0 };
}

function addMacros(a: Macros, b: Macros): Macros {
  return { kcal: a.kcal + b.kcal, protein: a.protein + b.protein,
    carbs: a.carbs + b.carbs, fat: a.fat + b.fat };
}

export function sumMacros(components: FoodComponent[]): Macros {
  return components.reduce((acc, c) => addMacros(acc, c.macros), zeroMacros());
}

function daySlotBaseline(dayType: DayType): Macros {
  return SLOT_ORDER[dayType].reduce((total, slot) => {
    const value = SLOT_TARGETS[dayType][slot];
    return value ? addMacros(total, value) : total;
  }, zeroMacros());
}

/** How far the effective revision sits from the authored slot distribution. */
export function ratiosFor(
  store: Store,
  date: string,
): { dayType: DayType; targets: Macros | null; ratios: Ratios } {
  const stored = store.days[date];
  // The revision in force on THIS date, with its own training weekdays (audit 2026-10-05 #16).
  const dayType = targetDayType(date, stored?.dayTypeOverride, store.settings);
  const targets = resolveTargets(dayType, store.settings, date)?.macros ?? null;
  const baseline = daySlotBaseline(dayType);
  return {
    dayType,
    targets,
    ratios: {
      carbRatio: targets && baseline.carbs > 0 ? targets.carbs / baseline.carbs : 1,
      fatRatio: targets && baseline.fat > 0 ? targets.fat / baseline.fat : 1,
      proteinRatio: targets && baseline.protein > 0 ? targets.protein / baseline.protein : 1,
    },
  };
}

/** Includes per-date added or authored meals; a saved eaten record always stays visible. */
export function plannedSlotIds(store: Store, date: string, dayType: DayType): SlotId[] {
  const ids = slotListFor(dayType, store.settings, date);
  const day = store.days[date];
  const extras = MEAL_IDS.filter((id) => {
    const override = day?.itemOverrides?.[id];
    return !ids.includes(id) && (override?.added || override?.title
      || (override?.components.length ?? 0) > 0 || day?.eaten?.[id] || day?.swaps?.[id]);
  });
  return [...ids, ...extras].filter((id) =>
    !day?.itemOverrides?.[id]?.removed || !!day?.eaten?.[id]);
}

/** A slot's share of the day, so a build preview matches the card. Undefined for a fixed slot. */
export function scaledSlotTarget(store: Store, date: string, dayType: DayType, slot: SlotId): Macros | undefined {
  return slotTarget(store, date, dayType, slot, false);
}

/**
 * The share a meal would receive if the user planned (or re-planned) it: the slot itself counts as
 * open even when it holds a saved meal or was cleared, so the Plan sheet always has a number while
 * the account has a target. An eaten slot has none: its budget is spent, and planning it again
 * would write an override over what Today counts as eaten.
 */
export function planningSlotTarget(store: Store, date: string, dayType: DayType, slot: SlotId): Macros | undefined {
  if (store.days[date]?.eaten?.[slot]) return undefined;
  return slotTarget(store, date, dayType, slot, true);
}

/**
 * Logged food spends the day's budget beside the slots, every entry exactly once. A log filed
 * under an eaten slot with nothing saved to describe it is that meal's record: the slot is fixed
 * at zero for it (fixedMacros), so the log counts here and nowhere else.
 */
export function loggedOutsideSlots(day: StoredDay | undefined): Macros {
  return (day?.extras ?? []).reduce((acc, entry) => addMacros(acc, entryMacros(entry)), zeroMacros());
}

/**
 * The share an eaten slot with nothing saved to describe it is frozen at: the day's target split
 * evenly over its planned meals. It does not depend on what any other slot holds, on a skip, or
 * on a log, so ticking a meal is final and nothing later rewrites it (2026-10-04 audit). Such a
 * mark is an old timestamp-only tick (before freeze-on-tick, 2026-09-27) or a tick on a slot that
 * showed no meal, so nothing recorded its real size; the even share is the plan's own guess.
 */
function frozenShare(targets: Macros, slotCount: number): Macros {
  const pool = remainingPool(targets, zeroMacros());
  return { kcal: pool.kcal / slotCount, protein: pool.protein / slotCount,
    carbs: pool.carbs / slotCount, fat: pool.fat / slotCount };
}

type Fixed = { id: SlotId; macros: Macros };

/** What a slot already holds, when that is not the open share; null for an open slot. `frozen`
 *  is what an undescribed eaten slot holds (frozenShare). */
function fixedMacros(stored: StoredDay | undefined, id: SlotId, frozen: Macros): Macros | null {
  const override = stored?.itemOverrides?.[id];
  // An eaten recipe snapshot is what was actually eaten, whatever the override says (R4) — but
  // only while the override still agrees with it. A later edit or swap (followPlan: false,
  // different components) means this slot moved on from the recipe it was marked eaten against.
  // The Plan panel's logged shell drops the snapshot (consumedSnapshot): the log is the record.
  const consumed = consumedSnapshot(stored, id);
  if (consumed && (!override || (override.baseMealId === consumed.baseMealId
    && sameFoodComponents(override.components, consumed.components)))) {
    return sumMacros(consumed.components);
  }
  // A diverged override wins only when it is a genuine non-empty replacement AND, if the slot was
  // eaten, it shares the eaten meal's own lineage. An override with no such lineage is a stale
  // leftover the accept overlay never reconciles once the slot is eaten
  // (lib/recipes/accepted-overlay.ts: "an eaten snapshot is historical fact").
  if (override && override.components.length > 0 && !override.followPlan
    && (!consumed || override.baseMealId === consumed.baseMealId)) {
    return sumMacros(override.components);
  }
  if (consumed) return sumMacros(consumed.components);
  // A cleared (skipped) slot is fixed at zero, so its share goes to the open slots.
  if (override && !override.followPlan
    && (!override.added || override.cleared || override.components.length > 0)) {
    return sumMacros(override.components);
  }
  // An eaten slot never returns to the open pool. With nothing saved to describe it, a log filed
  // under it is the record (zero here, the log counts once in loggedOutsideSlots); without one it
  // holds its frozen share. Any other eaten slot that reaches here holds what its card shows:
  // nothing.
  if (stored?.eaten?.[id]) {
    const snapshot = eatenPlanSnapshotIfUnlogged(stored, id);
    if (snapshot) return sumMacros(snapshot);
    if (!undescribedEatenSlots(stored, [id]).has(id) || slotHasOwnLog(stored, id)) return zeroMacros();
    return { ...frozen };
  }
  return null;
}

/**
 * What an eaten slot with nothing saved to describe it counts as: its frozen share, or undefined
 * when a log filed under it is the record (or the account has no target). The estimate card
 * (lib/plan/eaten-estimate.ts) shows exactly this, so the card, the day's total and every other
 * slot's share agree.
 */
export function frozenEatenShare(store: Store, date: string, dayType: DayType, slot: SlotId): Macros | undefined {
  const stored = store.days[date];
  if (!slot.startsWith("meal-") || !undescribedEatenSlots(stored, [slot]).has(slot)
    || slotHasOwnLog(stored, slot)) return undefined;
  const { targets } = ratiosFor(store, date);
  const slots = plannedSlotIds(store, date, dayType);
  return targets && slots.includes(slot) ? frozenShare(targets, slots.length) : undefined;
}

function slotTarget(store: Store, date: string, dayType: DayType, slot: SlotId,
  planning: boolean): Macros | undefined {
  if (!slot.startsWith("meal-")) return undefined;
  const { targets } = ratiosFor(store, date);
  if (!targets) return undefined;
  const stored = store.days[date];
  const slots = plannedSlotIds(store, date, dayType);
  if (!slots.includes(slot)) return undefined;
  const frozen = frozenShare(targets, slots.length);
  const fixed = slots.flatMap((id): Fixed[] => {
    // Planning a slot that is not eaten treats it as open, whatever it holds now.
    if (planning && id === slot && !stored?.eaten?.[id]) return [];
    const macros = fixedMacros(stored, id, frozen);
    return macros ? [{ id, macros }] : [];
  });
  if (fixed.some((item) => item.id === slot)) return undefined;
  const count = slots.length - fixed.length;
  if (count <= 0) return undefined;
  const used = fixed.reduce((acc, item) => addMacros(acc, item.macros),
    loggedOutsideSlots(stored));
  const pool = remainingPool(targets, used);
  return { kcal: pool.kcal / count, protein: pool.protein / count,
    carbs: pool.carbs / count, fat: pool.fat / count };
}

/**
 * What is left of the day once `used` is paid, as one feasible vector. kcal is what remains of the
 * kcal target; the macros are fitted inside it, protein first, then fat, then carbs (the order
 * lib/scaling.ts protects them in), so kcal >= 4P + 4C + 9F always holds.
 *
 * Subtracting and clamping each macro on its own is not enough: an overspent macro clamps to zero,
 * but its extra energy has already come out of kcal, so the other macros would ask for more energy
 * than is left. The owner's 2026-10-04 day: saved meals over the fat target left 222 kcal but
 * 73.1 g protein (292 kcal), and Meal 1 read "about 111 kcal · 37 g protein".
 */
export function remainingPool(targets: Macros, used: Macros): Macros {
  const left = (key: keyof Macros) => Math.max(0, targets[key] - used[key]);
  const kcal = left("kcal");
  const protein = Math.min(left("protein"), kcal / 4);
  const afterProtein = Math.max(0, kcal - 4 * protein);
  const fat = Math.min(left("fat"), afterProtein / 9);
  const carbs = Math.min(left("carbs"), Math.max(0, afterProtein - 9 * fat) / 4);
  return { kcal, protein, carbs, fat };
}
