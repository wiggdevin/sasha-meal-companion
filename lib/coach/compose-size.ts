/**
 * The arithmetic behind a composed meal — T6 §4. Split out of lib/coach/compose.ts so that file
 * stays the orchestration: which food, off which list, in which order.
 *
 * Pure. No I/O, no Supabase import, and no knowledge of the card.
 */

import type { FoodHit } from "@/lib/coach/executors";

/** One meal's worth of macros: the target, the totals and an item's own share all take this shape. */
export type MealMacros = { kcal: number; protein: number; carbs: number; fat: number };

export const MIN_GRAMS = 15;
export const MAX_GRAMS = 400;
/** No item may run away with the meal: at most twice the portion a person actually serves. */
export const PORTION_CAP_MULTIPLE = 2;
const DEFAULT_PORTION_G = 150;

export type Role = "protein" | "carb" | "fat";

export function macrosFor(hit: Pick<FoodHit, "kcalPer100g" | "proteinPer100g" | "carbsPer100g"
  | "fatPer100g">, grams: number) {
  const per = (value: number | null | undefined) => ((value ?? 0) * grams) / 100;
  const kcal = hit.kcalPer100g != null ? per(hit.kcalPer100g)
    : per(hit.proteinPer100g) * 4 + per(hit.carbsPer100g) * 4 + per(hit.fatPer100g) * 9;
  return {
    kcal: Math.round(kcal),
    protein: Math.round(per(hit.proteinPer100g) * 10) / 10,
    carbs: Math.round(per(hit.carbsPer100g) * 10) / 10,
    fat: Math.round(per(hit.fatPer100g) * 10) / 10,
  };
}

export function roleOf(hit: Pick<FoodHit, "proteinPer100g" | "carbsPer100g" | "fatPer100g">): Role {
  const protein = (hit.proteinPer100g ?? 0) * 4;
  const carbs = (hit.carbsPer100g ?? 0) * 4;
  const fat = (hit.fatPer100g ?? 0) * 9;
  if (protein >= carbs && protein >= fat) return "protein";
  return fat > carbs ? "fat" : "carb";
}

export const clamp = (grams: number) =>
  Math.max(MIN_GRAMS, Math.min(MAX_GRAMS, Math.round(grams / 5) * 5));

/** No item may exceed twice its household portion: a 385 g "sandwich wrap" is not a wrap. */
const ceiling = (hit: FoodHit) =>
  PORTION_CAP_MULTIPLE * (hit.portionGrams && hit.portionGrams > 0
    ? hit.portionGrams : DEFAULT_PORTION_G);
export const capped = (hit: FoodHit, grams: number) => Math.min(clamp(grams), clamp(ceiling(hit)));

/**
 * The same cap for the ADDED food, but never below twice a real serving. The catalogue's default
 * portion for "Avocado, raw" is 15 g — one tablespoon, a measure rather than a serving — so the
 * plain cap held the fat filler to 30 g when the gap wanted 120 (measured 2026-09-18).
 */
const MIN_SERVING_G = 50;
export function cappedComplement(hit: FoodHit, grams: number): number {
  // Five grams of a concentrated fat is a real kitchen portion. Applying the generic 15 g food
  // floor to oil adds at least 135 kcal and can push an otherwise target-sized meal outside the
  // admission window.
  const floor = (hit.fatPer100g ?? 0) >= 50 ? 5 : MIN_GRAMS;
  const rounded = Math.max(floor, Math.min(MAX_GRAMS, Math.round(grams / 5) * 5));
  return Math.min(rounded,
    clamp(PORTION_CAP_MULTIPLE * Math.max(hit.portionGrams ?? 0, MIN_SERVING_G)));
}

/**
 * Grams for each chosen food, in two passes.
 *
 * The carb and fat foods are sized first, to the carb and fat targets. Then the protein foods
 * carry whatever protein is LEFT after those — a wrap and an avocado bring real protein with them,
 * and sizing the chicken to the whole target on top of them overshot it by a quarter. Protein is
 * the number that never moves (PRD §7.5), so it is the one the second pass aims at exactly.
 */
export function sizeItems(
  chosen: { hit: FoodHit }[], target: MealMacros,
): number[] {
  const roles = chosen.map(({ hit }) => roleOf(hit));
  const share = (role: Role) => Math.max(1, roles.filter((r) => r === role).length);
  const per100 = (hit: FoodHit, role: Role) =>
    role === "protein" ? hit.proteinPer100g ?? 0
      : role === "carb" ? hit.carbsPer100g ?? 0 : hit.fatPer100g ?? 0;

  const grams = chosen.map(({ hit }, index) => {
    const role = roles[index];
    if (role === "protein") return 0;
    const want = (role === "carb" ? target.carbs : target.fat) / share(role);
    const density = per100(hit, role);
    return capped(hit, density <= 0 ? 100 : (want / density) * 100);
  });

  const carried = chosen.reduce((sum, { hit }, index) =>
    sum + ((hit.proteinPer100g ?? 0) * grams[index]) / 100, 0);
  const left = Math.max(0, target.protein - carried);
  // The MAIN is the first protein the wish names; only it gets the floor, and only while the named
  // foods together are still under the protein target. A wrap that already covers the protein is
  // not a reason to grow the chicken on top of it.
  const main = left > 0 ? roles.indexOf("protein") : -1;
  return chosen.map(({ hit }, index) => {
    if (roles[index] !== "protein") return grams[index];
    const density = hit.proteinPer100g ?? 0;
    if (density <= 0) return capped(hit, 100);
    const even = left / share("protein");
    const floor = index === main ? MAIN_FLOOR * (target.protein / share("protein")) : 0;
    return capped(hit, (Math.max(even, floor) / density) * 100);
  });
}

/**
 * The floor under a named protein. A wrap sized to a 95 g carb target carries 12.6 g protein by
 * itself, which left 9.4 g for the chicken — 30 g of chicken in a "chicken wrap" (measured
 * 2026-09-18). The food the user NAMED is the meal; it never falls below half the share it was asked
 * for, whatever the carb beside it happens to carry. The portion ceiling still wins over it.
 */
export const MAIN_FLOOR = 0.5;

export const FIT_TOLERANCE = 0.1;

/**
 * The smallest miss that counts. 10 % of a small slot's 10 g of fat is 1 g, which no real plate
 * hits on all four macros at once, so the Plan sheet threw away every idea for a snack-sized or
 * late slot ("No ready meal options yet", integration run 2026-10-17). A miss inside 3 g, or
 * 30 kcal, fits whatever the target.
 */
export const FIT_FLOOR_G = 3;
export const FIT_FLOOR_KCAL = 30;

function withinBar(actual: number, target: number, floor: number): boolean {
  if (target <= 0) return true;
  return Math.abs(actual - target) <= Math.max(target * FIT_TOLERANCE, floor);
}

const floorFor = (macro: keyof MealMacros) => macro === "kcal" ? FIT_FLOOR_KCAL : FIT_FLOOR_G;

const macroFits = (totals: MealMacros, target: MealMacros, macro: keyof MealMacros) =>
  withinBar(totals[macro], target[macro], floorFor(macro));

/**
 * Every macro within 10 % of the per-meal target (or `FIT_FLOOR_G` / `FIT_FLOOR_KCAL`, whichever is
 * wider), protein checked FIRST (ruling 2026-09-18).
 * Protein is the number that never moves (PRD §7.5), so it is the one whose miss decides the
 * answer, and the order here is the order the sizing pass aims at them.
 */
export function fitsTarget(
  totals: MealMacros, target: MealMacros,
): boolean {
  return FIT_ORDER.every((macro) => macroFits(totals, target, macro));
}

const FIT_ORDER = ["protein", "kcal", "carbs", "fat"] as const;

/**
 * The miss, in their words, for the card to show — "Over on protein by 5 g, under on fat by 12 g for
 * this slot". EVERY macro that missed is named, protein first (it is the number that never moves,
 * PRD §7.5): naming only the worst one let their fix that one and still miss the slot. Null when
 * every macro is inside the bar, which is the same answer `fitsTarget` gives.
 */
export function fitNote(totals: MealMacros, target: MealMacros): string | null {
  const misses: string[] = [];
  for (const macro of FIT_ORDER) {
    if (macroFits(totals, target, macro)) continue;
    const by = Math.round(Math.abs(totals[macro] - target[macro]));
    // A miss that rounds to nothing is not worth a word: "by 0 g" reads like a bug, not a warning.
    if (by < 1) continue;
    const way = totals[macro] > target[macro] ? "over" : "under";
    misses.push(`${way} on ${macro} by ${by} ${macro === "kcal" ? "kcal" : "g"}`);
  }
  if (misses.length === 0) return null;
  const line = misses.join(", ");
  return `${line[0].toUpperCase()}${line.slice(1)} for this slot`;
}

/** A macro is a food's own, rather than an accident of it, at a quarter of its energy or more. */
export const SOURCE_SHARE = 0.25;

/**
 * Every macro this food is a real SOURCE of, not just its dominant one. "Ground beef, 80/20" is a
 * fat by `roleOf` and a protein by any honest reading, and the complement picker used to take it
 * for a fat gap and hand the meal 17 g of protein it had not asked for (measured 2026-09-18).
 */
export function macroSources(
  hit: Pick<FoodHit, "proteinPer100g" | "carbsPer100g" | "fatPer100g">,
): Set<Role> {
  const energy: [Role, number][] = [
    ["protein", (hit.proteinPer100g ?? 0) * 4],
    ["carb", (hit.carbsPer100g ?? 0) * 4],
    ["fat", (hit.fatPer100g ?? 0) * 9],
  ];
  const total = energy.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return new Set<Role>();
  return new Set(energy.filter(([, value]) => value / total >= SOURCE_SHARE).map(([role]) => role));
}

/**
 * The macros the sized meal already has, read off its TOTALS rather than off which foods the wish
 * happened to name. A macro is covered when the totals are inside the fit bar or above it, and a
 * macro the slot does not ask for is covered by definition.
 *
 * This is what makes a salmon or a handful of nuts eligible for a meal short on protein AND fat:
 * naming a protein is not the same as having sized one (Grok pass 1, 2026-09-18).
 */
export function coveredMacros(totals: MealMacros, target: MealMacros): Set<Role> {
  const covered = new Set<Role>();
  const has = (actual: number, want: number) => want <= 0 || actual >= want * (1 - FIT_TOLERANCE);
  if (has(totals.protein, target.protein)) covered.add("protein");
  if (has(totals.carbs, target.carbs)) covered.add("carb");
  if (has(totals.fat, target.fat)) covered.add("fat");
  return covered;
}

/** How far under the target a macro is, as a fraction. Anything at or above the bar is 0. */
function shortfall(actual: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, (target - actual) / target);
}

/** The macro the named foods could not carry, if any. Fat first, then carbs. */
export function missingMacro(
  totals: MealMacros, target: MealMacros,
): "fat" | "carbs" | null {
  if (shortfall(totals.fat, target.fat) > FIT_TOLERANCE) return "fat";
  if (shortfall(totals.carbs, target.carbs) > FIT_TOLERANCE) return "carbs";
  return null;
}

/** A suggestion may use the next slot's shape, but it may never promise more than remains today. */
export function clampMealTarget(target: MealMacros, remaining: MealMacros): MealMacros {
  return {
    kcal: Math.min(target.kcal, remaining.kcal),
    protein: Math.min(target.protein, remaining.protein),
    carbs: Math.min(target.carbs, remaining.carbs),
    fat: Math.min(target.fat, remaining.fat),
  };
}

export const NOTHING_LEFT = "nothing-left" as const;

/**
 * A snack always follows what remains today, even when the request names a meal slot. Every macro
 * moves by the calorie ratio so the capped target remains the same feasible vector.
 */
export function snackTarget(
  stillToEat: MealMacros,
  cap: number | null,
  _slotTarget?: MealMacros,
): MealMacros | typeof NOTHING_LEFT {
  if (stillToEat.kcal <= 0) return NOTHING_LEFT;
  const kcal = Math.min(stillToEat.kcal, cap ?? stillToEat.kcal);
  const ratio = kcal / stillToEat.kcal;
  return {
    kcal,
    protein: stillToEat.protein * ratio,
    carbs: stillToEat.carbs * ratio,
    fat: stillToEat.fat * ratio,
  };
}
