/**
 * The foods a generated plate may use: this account's Eats with usable nutrition, one row per
 * food name. Pure. No I/O.
 */

import type { Food } from "@/lib/foods";
import { macroKcal } from "@/lib/scaling";
import { byCode, carriesPart, foodKey, partsOf } from "@/lib/meals/parts";

/**
 * A food may enter generation only when its per-unit nutrition is usable for the part it plays:
 * finite, non-negative macros, positive energy, and a positive amount of the macro its role
 * supplies. A food with unknown or zero nutrition is skipped, never picked (AI-integration audit,
 * GPT-6 Sol finding B4: a zero-fat "fat" made the pick `undefined`).
 */
export function usableForGeneration(food: Food): boolean {
  const { protein, carbs, fat } = food.perUnit;
  if (![protein, carbs, fat].every((value) => Number.isFinite(value) && value >= 0)) return false;
  if (macroKcal(food.perUnit) <= 0) return false;
  if (food.role === "protein") return protein > 0;
  if (food.role === "carb") return carbs > 0;
  return fat > 0;
}

/** Eats with usable nutrition, one per name, in a stable order (name, then id). */
export function generationPool(foods: readonly Food[] | Readonly<Record<string, Food>>): Food[] {
  const list = (Array.isArray(foods) ? [...foods] : Object.values(foods)) as Food[];
  const seen = new Set<string>();
  return list.filter((food) => food.status === "eats" && usableForGeneration(food))
    .sort((a, b) => byCode(foodKey(a), foodKey(b)) || byCode(a.id, b.id))
    .filter((food) => {
      const key = foodKey(food);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The distinct anchors (proteins) a pool offers. */
export function poolAnchors(pool: readonly Food[]): Food[] {
  return pool.filter((food) => partsOf(food).includes("anchor") && carriesPart(food, "anchor"));
}
