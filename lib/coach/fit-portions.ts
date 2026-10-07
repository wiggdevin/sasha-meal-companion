/**
 * Resize a named-slot meal's existing portions so every macro lands inside the 10 % fit bar.
 *
 * One uniform ratio could only fix a meal that was over (or under) on everything at once; a meal
 * over on carbs and under on protein could never fit and was dropped, which ended in "No ready meal
 * options". Each item's grams now move on their own: a box-bounded least-squares fit over the
 * item grams (coordinate descent, exact per-item step), reweighted toward any macro still outside
 * the bar. Deterministic, a few hundred multiplications, no model call.
 *
 * The foods and the account's target never change; the caller re-checks every verdict at the new
 * grams. Bounds keep the meal the meal it was: every item stays within half to twice its composed
 * portion (and under MAX_GRAMS), the protein foods never fall below three quarters of theirs, and
 * the food that carried the most protein still carries the most after resizing. A protein portion
 * moves only toward the protein target, never as calorie slack (2026-10-03 audit, MAJOR 2):
 * calories are met by the carbs and fat. No item grows past its plausible serving
 * (lib/coach/portion-bands.ts, 2026-10-03): a meal that only fits with 387 g of scallops does not fit.
 *
 * Pure. No I/O.
 */

import type { ComposedItem, ComposedMeal } from "@/lib/coach/compose";
import { FIT_TOLERANCE, MAX_GRAMS, fitNote, fitsTarget, macrosFor, roleOf, type MealMacros }
  from "@/lib/coach/compose-size";
import { partFromRole, portionBand, type PortionBand } from "@/lib/coach/portion-bands";

const KEYS = ["kcal", "protein", "carbs", "fat"] as const;
type Key = (typeof KEYS)[number];

const SHRINK = 0.5;
const GROW = 2;
const PROTEIN_SHRINK = 0.75;
const SWEEPS = 120;
const REWEIGHT_ROUNDS = 10;
/** Aim a little inside the bar, so rounding grams cannot push a macro back out of it. */
const AIM = FIT_TOLERANCE * 0.8;
/** Protein is the number that never moves (PRD §7.5): its miss counts double from the start. */
const BASE_WEIGHT: Record<Key, number> = { kcal: 1, protein: 2, carbs: 1, fat: 1 };

/** Macros per gram of an item, kcal read the same way `macrosFor` reads it. */
export function perGram(item: ComposedItem): Record<Key, number> {
  const protein = (item.proteinPer100g ?? 0) / 100;
  const carbs = (item.carbsPer100g ?? 0) / 100;
  const fat = (item.fatPer100g ?? 0) / 100;
  const kcal = item.kcalPer100g != null ? item.kcalPer100g / 100 : protein * 4 + carbs * 4 + fat * 9;
  return { kcal, protein, carbs, fat };
}

export function sumMacros(items: { macros: MealMacros }[]): MealMacros {
  return items.reduce((sum, item) => ({
    kcal: sum.kcal + item.macros.kcal,
    protein: Math.round((sum.protein + item.macros.protein) * 10) / 10,
    carbs: Math.round((sum.carbs + item.macros.carbs) * 10) / 10,
    fat: Math.round((sum.fat + item.macros.fat) * 10) / 10,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

/** Box-bounded weighted least squares on relative misses, by coordinate descent. */
export function solve(
  density: Record<Key, number>[], start: number[], lo: number[], hi: number[], target: MealMacros,
): number[] {
  const keys = KEYS.filter((key) => target[key] > 0);
  const weight: Record<Key, number> = { ...BASE_WEIGHT };
  const grams = [...start];
  for (let round = 0; round < REWEIGHT_ROUNDS; round += 1) {
    for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
      for (let i = 0; i < grams.length; i += 1) {
        let num = 0;
        let den = 0;
        for (const key of keys) {
          const scale = weight[key] / (target[key] * target[key]);
          const residual = density.reduce((sum, d, j) => sum + d[key] * grams[j], 0) - target[key];
          num += scale * density[i][key] * residual;
          den += scale * density[i][key] * density[i][key];
        }
        if (den <= 0) continue;
        grams[i] = Math.min(hi[i], Math.max(lo[i], grams[i] - num / den));
      }
    }
    const misses = keys.filter((key) => {
      const actual = density.reduce((sum, d, j) => sum + d[key] * grams[j], 0);
      return Math.abs(actual - target[key]) > target[key] * AIM;
    });
    if (misses.length === 0) break;
    for (const key of misses) weight[key] *= 4;
  }
  return grams;
}

/** `value` rounded to `step`, inside [lo, hi] on the step grid when the grid has a point there. */
export function snap(value: number, lo: number, hi: number, step: number): number {
  const low = Math.ceil(lo / step - 1e-9) * step;
  const high = Math.floor(hi / step + 1e-9) * step;
  if (low > high) return Math.min(hi, Math.max(lo, value));
  return Math.min(high, Math.max(low, Math.round(value / step) * step));
}

/** The anchor, a second protein, or (on an untagged meal) a food whose main macro is protein. */
export function isProteinItem(item: ComposedItem): boolean {
  if (item.part !== undefined) return item.part === "anchor" || item.part === "protein";
  return roleOf(item) === "protein";
}

/**
 * Narrow each protein item's [lo, hi] to lie between its grams now and the grams that meet the
 * protein target (the other foods' protein counted as it is). Inside that range a protein food can
 * only move to correct protein; it is never the calorie slack. Non-protein items keep their bounds.
 */
/** A protein item's grams before the fit, and the grams that would meet the protein target. */
export type ProteinAim = { from: number; aim: number };

export function boundProtein(
  items: ComposedItem[], grams: number[], lo: number[], hi: number[], target: MealMacros,
): (ProteinAim | null)[] {
  const flags = items.map(isProteinItem);
  const per = items.map(perGram);
  const carried = (own: boolean) => grams.reduce((total, g, i) =>
    total + (flags[i] === own ? per[i].protein * g : 0), 0);
  const own = carried(true);
  const aims: (ProteinAim | null)[] = items.map(() => null);
  if (target.protein <= 0 || own <= 0) return aims;
  const ratio = Math.max(0, (target.protein - carried(false)) / own);
  grams.forEach((g, i) => {
    if (!flags[i]) return;
    aims[i] = { from: g, aim: g * ratio };
    const low = Math.max(lo[i], Math.min(g, g * ratio));
    const high = Math.min(hi[i], Math.max(g, g * ratio));
    if (low <= high) { lo[i] = low; hi[i] = high; return; }
    // The band and the protein range do not meet: hold the band edge nearest the protein range.
    const edge = high < lo[i] ? lo[i] : hi[i];
    lo[i] = edge; hi[i] = edge;
  });
  return aims;
}

/**
 * A coarse-step protein item (whole eggs) whose protein range [lo, hi] holds no whole count: the
 * band step just outside the range that moves protein toward the target, nearest the target
 * (re-audit r2 #1). A count that would move protein away from the target is never chosen; the
 * fallback is the band grid nearest `value`, as before.
 */
export function stepTowardAim(
  value: number, lo: number, hi: number, band: PortionBand, aim: ProteinAim,
): number {
  const { step } = band;
  const first = Math.ceil(band.min / step - 1e-9) * step;
  const last = Math.floor(band.max / step + 1e-9) * step;
  const wrongWay = (grams: number) => (aim.aim > aim.from && grams < aim.from)
    || (aim.aim < aim.from && grams > aim.from);
  const options = [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step]
    .filter((grams) => grams >= first && grams <= last && !wrongWay(grams))
    .sort((a, b) => Math.abs(a - aim.aim) - Math.abs(b - aim.aim));
  return options[0] ?? snap(value, band.min, band.max, step);
}

function resized(
  meal: ComposedMeal, grams: number[], step: number, lo: number[], hi: number[],
): ComposedMeal {
  const items = meal.items.map((item, index) => {
    const rounded = Math.max(Math.min(step, hi[index]), snap(grams[index], lo[index], hi[index], step));
    const exact = Math.round(rounded * 10) / 10;
    return { ...item, grams: exact, macros: macrosFor(item, exact) };
  });
  const totals = sumMacros(items);
  const fits = fitsTarget(totals, meal.target);
  return { ...meal, items, totals, fitsTarget: fits, fitNote: fits ? null : fitNote(totals, meal.target) };
}

function topProtein(items: ComposedItem[]): number {
  return items.reduce((best, item, index) =>
    item.macros.protein > items[best].macros.protein ? index : best, 0);
}

/** Resize a near-fit named meal without changing its foods, policy verdicts, or account target. */
export function fitNamedMealPortions(meal: ComposedMeal): ComposedMeal {
  if (meal.fitsTarget || meal.items.length === 0) return meal;
  const density = meal.items.map(perGram);
  // Never shrink below a plausible serving it already had: a 75 g vegetable side stays one.
  const lo = meal.items.map((item) => Math.max(item.grams
    * (roleOf(item) === "protein" ? PROTEIN_SHRINK : SHRINK), Math.min(item.grams, bandOf(item).min)));
  const hi = meal.items.map((item) => Math.max(item.grams,
    Math.min(MAX_GRAMS, item.grams * GROW, bandOf(item).max)));
  boundProtein(meal.items, meal.items.map((item) => item.grams), lo, hi, meal.target);
  // Whole eggs stay whole: a unit-count item keeps the count it was composed with. Egg whites and
  // milk (a 10 g step) are grams, not counts, and still move (re-audit r2 #7).
  meal.items.forEach((item, i) => {
    if (isUnitCount(bandOf(item)) && item.grams % bandOf(item).step === 0) { lo[i] = item.grams; hi[i] = item.grams; }
  });
  const grams = solve(density, meal.items.map((item) => item.grams), lo, hi, meal.target);
  const main = topProtein(meal.items);
  for (const step of [1, 0.1]) {
    const candidate = resized(meal, grams, step, lo, hi);
    if (!candidate.fitsTarget) continue;
    // The food that made this a protein meal stays the protein: no resize may hand that to a side.
    const lead = candidate.items[topProtein(candidate.items)].macros.protein;
    return lead > candidate.items[main].macros.protein ? meal : candidate;
  }
  return meal;
}

/** A band counted in whole units (an egg is 50 g), not grams on a fine grid. */
export const UNIT_COUNT_STEP = 50;
export function isUnitCount(band: PortionBand): boolean {
  return band.step >= UNIT_COUNT_STEP;
}

/** The plausible band of a composed item: its template part when it has one, else its macros. */
export function bandOf(item: ComposedItem): PortionBand {
  return portionBand(item.name, item.part ?? partFromRole(roleOf(item)));
}

/**
 * Size a template meal's items inside their plausible bands, toward the slot target. Grams round
 * to each band's step (an egg is 50 g, oil 5 g). Deterministic; the foods never change.
 */
export function sizeWithinBands(
  items: ComposedItem[], target: MealMacros, start: number[], pinned: readonly boolean[] = [],
): ComposedItem[] {
  const bands = items.map(bandOf);
  // A pinned item (a vegetable side) keeps its seed: the solver would otherwise pile 200 g of
  // spinach onto a plate because it is the cheapest protein-and-carb in the meal.
  const lo = bands.map((band, i) => (pinned[i] ? Math.min(band.max, Math.max(band.min, start[i])) : band.min));
  const hi = bands.map((band, i) => (pinned[i] ? lo[i] : band.max));
  const seed = start.map((grams, index) => Math.min(hi[index], Math.max(lo[index], grams)));
  // The protein seed is protein-first; the solver may correct protein with it, never calories.
  const aims = boundProtein(items, seed, lo, hi, target);
  const density = items.map(perGram);
  let grams = solve(density, seed, lo, hi, target);
  // Grams sit on the band's step grid: inside [lo, hi] when the grid reaches it, else on the band's
  // own grid nearest the solution, so whole eggs stay whole even where the protein range falls
  // between two counts.
  const place = (value: number, i: number) => {
    const step = bands[i].step;
    const fits = Math.ceil(lo[i] / step - 1e-9) <= Math.floor(hi[i] / step + 1e-9);
    if (fits) return snap(value, lo[i], hi[i], step);
    const aim = aims[i];
    return aim ? stepTowardAim(value, lo[i], hi[i], bands[i], aim) : snap(value, bands[i].min, bands[i].max, step);
  };
  // A unit-count step (whole eggs) is rounded first and held, and the rest re-solve around it.
  const coarse = bands.map(isUnitCount);
  if (coarse.some(Boolean)) {
    const held = grams.map((value, i) => (coarse[i] ? place(value, i) : value));
    grams = solve(density, held, lo.map((v, i) => (coarse[i] ? held[i] : v)),
      hi.map((v, i) => (coarse[i] ? held[i] : v)), target);
  }
  return items.map((item, index) => {
    const rounded = coarse[index] ? grams[index] : place(grams[index], index);
    return { ...item, grams: rounded, macros: macrosFor(item, rounded) };
  });
}
