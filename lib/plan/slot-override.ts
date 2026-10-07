// lib/plan/slot-override.ts
/**
 * A slot edited by hand — Phase A of docs/plans/2026-09-14-slot-item-editing.md.
 *
 * A card edit changes a line, and the slot becomes what was actually eaten. The override keeps
 * the WHOLE resulting component list rather than a patch keyed by position: a positional patch
 * stops meaning anything the moment the rotation or an authored meal changes, and the list is also
 * the honest record of what was eaten.
 *
 * The slot recalculates and shows the difference against its target. It does NOT resize the other
 * items to hold that target — `lib/scaling.ts` still sizes the authored plan, and still never
 * moves protein. That was the logging ruling on 2026-09-14, and it makes this a record of
 * reality rather than a second planner.
 *
 * An override belongs to ONE date. Promoting it is a separate, deliberate act (Phase D).
 */
import type { FoodComponent, Macros, SlotOverride } from "@/lib/types";

export type { SlotOverride };

const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

/**
 * What the card shows. An override wins over the planned components — including an empty one,
 * which means the slot was cleared and is not the same as never having edited it.
 */
export function componentsForSlot(
  planned: FoodComponent[], override: SlotOverride | undefined
): FoodComponent[] {
  return override?.followPlan ? planned : override?.components ?? planned;
}

export function sumComponents(components: FoodComponent[]): Macros {
  return components.reduce<Macros>((total, c) => ({
    kcal: total.kcal + c.macros.kcal,
    protein: total.protein + c.macros.protein,
    carbs: total.carbs + c.macros.carbs,
    fat: total.fat + c.macros.fat,
  }), ZERO);
}

/** How far the slot sits from its target, positive meaning over. Null when the slot has none. */
export function slotDifference(actual: Macros, target: Macros | undefined): Macros | null {
  if (target === undefined) return null;
  return {
    kcal: actual.kcal - target.kcal,
    protein: actual.protein - target.protein,
    carbs: actual.carbs - target.carbs,
    fat: actual.fat - target.fat,
  };
}

/**
 * The three edits the card offers. Each returns a new list — `updateDay` spreads whatever it is
 * handed, so mutating in place would write through to the stored day before confirmation.
 *
 * An index that is not one of the list's lines returns the list unchanged rather than throwing: the
 * sheet can race a re-render, and a stale tap should do nothing, not lose the slot.
 */
export function replaceComponent(
  components: FoodComponent[], index: number, next: FoodComponent
): FoodComponent[] {
  if (index < 0 || index >= components.length) return components;
  return components.map((c, i) => (i === index ? next : c));
}

export function removeComponent(components: FoodComponent[], index: number): FoodComponent[] {
  if (index < 0 || index >= components.length) return components;
  return components.filter((_, i) => i !== index);
}

export function addComponent(
  components: FoodComponent[], next: FoodComponent
): FoodComponent[] {
  return [...components, next];
}

/** One decimal for macros, whole calories — the rounding lib/food-db.ts already uses. */
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Change how much of a line was eaten. The macros scale from what that line already carried, so a
 * "1 cup oat milk" at 125 kcal becomes 250 at two cups.
 *
 * A negative quantity, or a line with nothing to scale from, comes back unchanged: there is no
 * sensible answer and inventing one would put negative calories in the day.
 */
export function setComponentQty(component: FoodComponent, qty: number): FoodComponent {
  if (qty < 0 || component.qty <= 0) return component;
  const factor = qty / component.qty;
  return {
    ...component,
    qty,
    macros: {
      kcal: Math.round(component.macros.kcal * factor),
      protein: round1(component.macros.protein * factor),
      carbs: round1(component.macros.carbs * factor),
      fat: round1(component.macros.fat * factor),
    },
  };
}

/**
 * One tap on the minus or plus beside a line.
 *
 * Stepping the last one off removes the line: "I only had the banana" and "I did not have it" are
 * the same gesture continued, so there is no separate remove button to find. A line that would
 * land at zero comes off rather than sitting on the card counting nothing.
 */
export function stepComponent(
  components: FoodComponent[], index: number, delta: number
): FoodComponent[] {
  if (index < 0 || index >= components.length) return components;
  const next = components[index].qty + delta;
  if (next < 1) return removeComponent(components, index);
  return replaceComponent(components, index, setComponentQty(components[index], next));
}
