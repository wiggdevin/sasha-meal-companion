/**
 * The date → meal rotation. PRD §1.1.
 *
 * This is the seam between lib/plan.ts (which knows what a date means) and
 * lib/meals.ts (which knows what the options are). Neither owned it, so it
 * lives here.
 *
 * Everything is a pure function of the calendar date. There is no programme
 * start, no expiry, and no persisted "which meal is next" cursor — the same
 * date always yields the same meal, on any device, forever.
 */

import { composeMeal, eatsByRole, picksFromId, rotationPool, type Food } from "./foods";
import { FLOOR_DAY_MEALS, getMealOptions, isMealSlot, SLOT_TARGETS } from "./meals";
import { dayTypeFor, slotListFor } from "./plan";
import { ROTATION_EPOCH, type DayType, type Meal, type SlotId, type StoredDay } from "./types";

/**
 * Account meals are compiled only from synchronized foods. Ritual slots use the library.
 */
export function poolFor(dayType: DayType, slot: SlotId, foods?: Record<string, Food>): Meal[] {
  if (isMealSlot(slot)) {
    const target = SLOT_TARGETS[dayType][slot];
    if (target) return rotationPool(dayType, slot, target, foods ?? {});
    return [];
  }
  return getMealOptions(dayType, slot);
}

/**
 * Whole days between two ISO dates, computed in UTC to sidestep DST.
 * Both inputs are calendar dates (no time component), so UTC is safe here and
 * avoids the off-by-one that local-midnight arithmetic produces around a DST
 * boundary.
 */
export function daysSinceEpoch(date: string, epoch: string = ROTATION_EPOCH): number {
  const [ey, em, ed] = epoch.split("-").map(Number);
  const [dy, dm, dd] = date.split("-").map(Number);
  const a = Date.UTC(ey, em - 1, ed);
  const b = Date.UTC(dy, dm - 1, dd);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Per-slot phase offset, so the day's slots do not advance in lockstep.
 *
 * Without this every slot uses the same index, and on ~38% of days all three
 * meals landed on options sharing an ingredient — three bananas in one day,
 * three servings of melon the next. Measured over 21 days: 8 had an
 * ingredient appearing 3x. Nutritionally harmless, but it reads as a broken
 * plan and it is exactly the kind of thing that makes someone stop opening
 * the app.
 *
 * Offsets are co-prime-ish small integers so the slots drift out of phase
 * with each other and the combination cycles slowly.
 */
const SLOT_PHASE: Record<string, number> = {
  "coffee": 0,
  "pouches-pre": 1,
  "post-refuel": 1,
  "meal-1": 0,
  "meal-2": 2,
  "meal-3": 4,
  "hot-chocolate": 0,
};

/**
 * The rotation index for a date and slot. Stays non-negative for dates BEFORE
 * the epoch — JS `%` returns a negative remainder, which would throw an array
 * lookup off the front. Older dates are unlikely, but a wrong answer
 * here is silent, so it is handled rather than assumed away.
 */
export function rotationIndex(date: string, poolSize: number, slot?: SlotId): number {
  if (poolSize <= 0) return 0;
  const phase = slot ? (SLOT_PHASE[slot] ?? 0) : 0;
  const n = daysSinceEpoch(date) + phase;
  return ((n % poolSize) + poolSize) % poolSize;
}

/**
 * Same as rotationIndex, plus an attempt offset for the de-dup loop below.
 * Used per role (protein/carb/fat) so one role's own count is all that ever
 * decides that role's pick — see roleIndex's use in mealsForDay.
 */
function roleIndex(date: string, slot: SlotId, count: number, attempt: number): number {
  if (count <= 0) return 0;
  const phase = SLOT_PHASE[slot] ?? 0;
  const n = daysSinceEpoch(date) + phase + attempt;
  return ((n % count) + count) % count;
}

/**
 * The meal for one slot on one date.
 *
 * Precedence: an explicit swap wins over the rotation. A swap that no
 * longer resolves falls back to the rotation
 * rather than throwing.
 */
export function mealFor(
  date: string,
  slot: SlotId,
  opts: { dayType?: DayType; stored?: StoredDay; foods?: Record<string, Food> } = {},
): Meal | null {
  // Delegates to the day-level resolver so a single-slot lookup and the full
  // day always agree. Resolving one slot in isolation would skip the
  // de-duplication below, and the Week screen would then show a different meal
  // than Today for the same date.
  const day = mealsForDay(date, opts.stored, opts.dayType, opts.foods);
  return day.find((d) => d.slot === slot)?.meal ?? null;
}

/** Ingredient names in a meal, ignoring free items like coffee. */
function ingredientsOf(meal: Meal): string[] {
  return meal.components.filter((c) => c.role !== "free").map((c) => c.name);
}

/**
 * Every populated slot for a date, in schedule order, with its meal
 * resolved. Slots whose pool is empty are dropped rather than rendered blank.
 *
 * Resolution per slot: an explicit swap wins; otherwise the rotation index,
 * then advanced forward while the candidate would put a third serving of the
 * same ingredient on the same day.
 *
 * WHY the de-duplication: with a plain per-slot index the meals advance in
 * near-lockstep and land on options sharing an ingredient. Measured over 60
 * days, 15% still served the same ingredient three times — three bananas one
 * day, three servings of avocado the next. Phase offsets alone did not fix it,
 * because different pool positions still share foods. Harmless nutritionally,
 * but it reads as a broken plan.
 *
 * Still a pure function of the date: slots resolve in a fixed order, so the
 * same date always yields the same day, on any device, forever.
 */
export function mealsForDay(
  date: string,
  stored?: StoredDay,
  dayTypeOverride?: DayType,
  foods?: Record<string, Food>,
): { slot: SlotId; meal: Meal }[] {
  const dayType = dayTypeOverride ?? dayTypeFor(date, stored?.dayTypeOverride);
  const out: { slot: SlotId; meal: Meal }[] = [];
  const used = new Map<string, number>();

  const take = (meal: Meal) => {
    for (const name of ingredientsOf(meal)) used.set(name, (used.get(name) ?? 0) + 1);
  };
  // A candidate is rejected if it would make any ingredient appear 3+ times.
  const wouldTriple = (meal: Meal) =>
    ingredientsOf(meal).some((name) => (used.get(name) ?? 0) >= 2);

  for (const slot of slotListFor(dayType)) {
    const pool = poolFor(dayType, slot, foods);
    if (pool.length === 0) continue;

    const swappedId = stored?.swaps?.[slot];
    if (swappedId) {
      // A composed swap is rebuilt from its food ids so it resolves even when
      // it is not one of the rotation's own combinations. If a food in it has
      // since moved to Avoid, it does not resolve and the rotation takes over.
      const target = SLOT_TARGETS[dayType][slot];
      const picks = foods && target ? picksFromId(swappedId, foods) : null;
      const swapped = picks ? composeMeal(slot, target!, picks) : pool.find((m) => m.id === swappedId);
      if (swapped) {
        out.push({ slot, meal: swapped });
        take(swapped);
        continue;
      }
    }

    const target = foods && isMealSlot(slot) ? SLOT_TARGETS[dayType][slot] : undefined;
    let chosen: Meal;
    if (foods && target) {
      // A composed slot (meal-1/2/3): pick protein, carb and fat each from
      // its OWN eats count, independently. Picking a single index into the
      // combined protein×carb×fat pool (below) ties every role together
      // through that pool's size — which is capped (MAX_POOL in foods.ts)
      // once the true combination count gets large, and a cap that stops
      // being an exact multiple of one role's count reshuffles every OTHER
      // role's pick too. Per-role indices have no such dependency: avoiding
      // a protein can only ever change which protein a date lands on.
      const by = eatsByRole(foods);
      const proteinPool = by.protein;
      const carbPool = by.carb;
      const fatPool = by.fat;
      const P = proteinPool.length;
      const C = carbPool.length;
      const F = fatPool.length;
      const pick = (attempt: number) => ({
        protein: P ? proteinPool[roleIndex(date, slot, P, attempt)] : null,
        carb: C ? carbPool[roleIndex(date, slot, C, attempt)] : null,
        fat: F ? fatPool[roleIndex(date, slot, F, attempt)] : null,
      });
      chosen = composeMeal(slot, target, pick(0));
      for (let i = 0; i < pool.length; i++) {
        const candidate = composeMeal(slot, target, pick(i));
        if (!wouldTriple(candidate)) {
          chosen = candidate;
          break;
        }
      }
    } else {
      const start = rotationIndex(date, pool.length, slot);
      chosen = pool[start];
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[(start + i) % pool.length];
        if (!wouldTriple(candidate)) {
          chosen = candidate;
          break;
        }
      }
    }
    out.push({ slot, meal: chosen });
    take(chosen);
  }

  return out;
}

/**
 * Floor Day: one tap replaces the whole day. PRD §7.2.
 *
 * Floor-day meals deliberately sit OUTSIDE the rotation pools — they are not
 * normal rotation options; they are the escape hatch for a difficult day. So
 * this reads FLOOR_DAY_MEALS directly rather than scanning getMealOptions.
 * Historical: no app path calls this; `resolveDay` never renders the template.
 */
export function floorDayMeals(): Meal[] {
  return FLOOR_DAY_MEALS;
}
