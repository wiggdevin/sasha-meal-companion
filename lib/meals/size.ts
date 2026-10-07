/**
 * Sizing a plate to a slot target inside every item's portion band (Phase 17 O1, D4/D5).
 *
 * Protein first (the anchor, then a second protein only for what the anchor cannot carry at its
 * band's top), a vegetable at a set portion, carbs from the starch and fruit, and fat last from
 * the calories that remain. Then the calorie gap is closed inside the bands: under → grow the
 * starch/fruit, then the fat, then the protein; over → shrink the fat, then the carbs, never the
 * protein below its target. Every amount is rounded with the app's own serving rule
 * (`roundToServing`) and stepped back inside the band when rounding pushed it out. A plate whose
 * item cannot sit inside its band at any serving size is not built.
 *
 * Pure. No I/O.
 */

import { componentFor, type Food } from "@/lib/foods";
import { macroKcal, roundToServing, SERVING_STEP } from "@/lib/scaling";
import type { FoodComponent, Macros } from "@/lib/types";
import { unitBand, type Part, type UnitBand } from "@/lib/meals/parts";
import { componentFoodKey } from "@/lib/meals/food-key";

export type PlateRow = { food: Food; part: Part };
export type SizedRow = PlateRow & { qty: number; component: FoodComponent };

const STEP: Record<Food["unit"], number> = SERVING_STEP;

/** Round to a serving, then step back inside the band; null when no serving fits. */
export function roundWithin(qty: number, unit: Food["unit"], band: UnitBand): number | null {
  const step = STEP[unit] ?? 1;
  let rounded = roundToServing(qty, unit);
  while (rounded > band.hi + 1e-9 && rounded - step > 1e-9) rounded = roundToServing(rounded - step, unit);
  if (rounded > band.hi + 1e-9) return null;
  if (rounded < band.lo * 0.8 - 1e-9) {
    const up = roundToServing(rounded + step, unit);
    if (up > band.hi + 1e-9 || up < band.lo * 0.8 - 1e-9) return null;
    rounded = up;
  }
  return rounded > 0 ? rounded : null;
}

const clamp = (value: number, band: UnitBand) => Math.min(band.hi, Math.max(band.lo, value));
const per = (row: PlateRow) => row.food.perUnit;
const kcalPer = (row: PlateRow) => macroKcal(row.food.perUnit);

/** Size a plate's rows to a target; null when an item cannot be served inside its band. */
/**
 * How many plates have been sized since the last reset: the D11 search-bound gate (at most 20,000
 * for a 6-slot day, W8 acceptance 5) reads it. Counting only; it never changes a result.
 */
export const sizePlateStats = { calls: 0 };

export function sizePlate(rows: readonly PlateRow[], target: Macros): SizedRow[] | null {
  sizePlateStats.calls += 1;
  const bands = rows.map((row) => unitBand(row.food, row.part));
  if (bands.some((band) => band === null)) return null;
  const band = (i: number) => bands[i] as UnitBand;
  const qty = rows.map((_, i) => band(i).typical);
  const idx = (parts: Part[]) => rows.flatMap((row, i) => (parts.includes(row.part) ? [i] : []));
  const anchor = idx(["anchor"]);
  const second = idx(["protein"]);
  const carbs = idx(["starch", "fruit"]);
  const fats = idx(["fat"]);
  const sumOf = (key: "protein" | "carbs" | "fat" | "kcal", skip: number[] = []) =>
    rows.reduce((total, row, i) => skip.includes(i) ? total
      : total + qty[i] * (key === "kcal" ? kcalPer(row) : per(row)[key]), 0);

  for (let pass = 0; pass < 3; pass += 1) {
    for (const i of anchor) {
      const need = target.protein - sumOf("protein", [...anchor, ...second]);
      qty[i] = clamp(need / per(rows[i]).protein, band(i));
    }
    for (const i of second) {
      const need = target.protein - sumOf("protein", second);
      qty[i] = need > 0 ? clamp(need / per(rows[i]).protein, band(i)) : band(i).lo;
    }
    const carbNeed = target.carbs - sumOf("carbs", carbs);
    carbs.forEach((i) => {
      const share = carbs.length === 1 ? carbNeed : carbNeed * (rows[i].part === "fruit" ? 0.35 : 0.65);
      qty[i] = clamp(share / per(rows[i]).carbs, band(i));
    });
    const kcalLeft = target.kcal - sumOf("kcal", fats);
    fats.forEach((i) => { qty[i] = clamp(kcalLeft / fats.length / kcalPer(rows[i]), band(i)); });
  }

  // Close the calorie gap inside the bands.
  const adjust = (order: number[], grow: boolean) => {
    for (const i of order) {
      const gap = target.kcal - sumOf("kcal");
      if (grow ? gap <= 0 : gap >= 0) return;
      const limit = grow ? band(i).hi : band(i).lo;
      qty[i] = grow ? Math.min(limit, qty[i] + gap / kcalPer(rows[i]))
        : Math.max(limit, qty[i] + gap / kcalPer(rows[i]));
    }
  };
  adjust([...carbs, ...fats, ...anchor, ...second], true);
  adjust([...fats, ...carbs], false);

  // Round everything but the fat, then size the fat to what is left and round it last.
  const rounded = qty.slice();
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].part === "fat") continue;
    const value = roundWithin(qty[i], rows[i].food.unit, band(i));
    if (value === null) return null;
    rounded[i] = value;
  }
  const fixedKcal = rows.reduce((total, row, i) => row.part === "fat" ? total
    : total + macroKcal(componentFor(row.food, rounded[i]).macros), 0);
  for (const i of fats) {
    const want = clamp((target.kcal - fixedKcal) / fats.length / kcalPer(rows[i]), band(i));
    const value = roundWithin(want, rows[i].food.unit, band(i));
    if (value === null) return null;
    rounded[i] = value;
  }
  return rows.map((row, i) => ({ ...row, qty: rounded[i], component: generatedComponent(row.food, rounded[i]) }));
}

/** A generated plate's line, carrying its food's identity for the taste profile (Phase 18 W3). */
function generatedComponent(food: Food, qty: number): FoodComponent {
  const foodKey = componentFoodKey(food);
  return { ...componentFor(food, qty), ...(foodKey ? { foodKey } : {}) };
}

export function totalOf(rows: readonly { component: FoodComponent }[]): Macros {
  return rows.reduce((sum, { component: { macros } }) => ({
    kcal: sum.kcal + macros.kcal, protein: sum.protein + macros.protein,
    carbs: sum.carbs + macros.carbs, fat: sum.fat + macros.fat,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

/**
 * Macro fit, 0..1: the calorie error and a protein shortfall weigh most (protein over is fine);
 * carbs and fat a little.
 */
export function macroFit(macros: Macros, target: Macros): number {
  return proteinFit(macros, target) * shapeFit(macros, target);
}

const PROTEIN_ROUNDING = 0.03;

/** The protein shortfall alone: protein leads every plate, so this never softens. */
export function proteinFit(macros: Macros, target: Macros): number {
  if (!(target.kcal > 0)) return 0;
  return proteinShortfallFit(macros.protein, target.protein);
}

/**
 * The shortfall penalty on grams alone, for a caller with no full macro target (a recipe serving,
 * a shopping-plan slot). 1 when there is no protein target or the shortfall is within 3 %.
 */
export function proteinShortfallFit(protein: number, targetProtein: number): number {
  const proteinShort = targetProtein > 0 ? Math.max(0, targetProtein - protein) / targetProtein : 0;
  // Within 3 % is serving rounding, not a shortfall: 44 g of a 45 g target must not outrank a
  // vegetable or a better pairing.
  return Math.exp(-Math.max(0, proteinShort - PROTEIN_ROUNDING) / 0.08);
}

/** Calories, carbs and fat. */
export function shapeFit(macros: Macros, target: Macros): number {
  if (!(target.kcal > 0)) return 0;
  const kcalErr = Math.abs(macros.kcal - target.kcal) / target.kcal;
  const carbErr = Math.abs(macros.carbs - target.carbs) / Math.max(target.carbs, 20);
  const fatErr = Math.abs(macros.fat - target.fat) / Math.max(target.fat, 10);
  return Math.exp(-kcalErr / 0.08) * Math.exp(-(carbErr + fatErr) / 3);
}

/** Inside 10 % of the calories with at least 90 % of the protein. */
export function fitsTarget(macros: Macros, target: Macros): boolean {
  return target.kcal > 0 && Math.abs(macros.kcal - target.kcal) <= target.kcal * 0.1
    && macros.protein >= target.protein * 0.9;
}
