import type { FoodComponent } from "../types";

/** A macro-value round-trip (JSON, numeric DB columns) can move a float by a trailing bit;
 *  that is not a real edit. */
const MACRO_EPSILON = 1e-6;
function sameMacroValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= MACRO_EPSILON;
}

/** True when `a` and `b` carry the same food lines (name, qty, unit, role, macros within a
 *  float round-trip's noise — 2026-10-03 audit). */
export function sameFoodComponents(a: FoodComponent[], b: FoodComponent[]): boolean {
  return a.length === b.length && a.every((item, i) => {
    const other = b[i];
    return item.name === other.name && item.qty === other.qty && item.unit === other.unit
      && item.role === other.role && sameMacroValue(item.macros.kcal, other.macros.kcal)
      && sameMacroValue(item.macros.protein, other.macros.protein)
      && sameMacroValue(item.macros.carbs, other.macros.carbs)
      && sameMacroValue(item.macros.fat, other.macros.fat);
  });
}
