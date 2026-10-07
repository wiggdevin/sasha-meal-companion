/**
 * Calorie adjustment -> macro redistribution, and meal portion scaling.
 * PRD §7.5 ("Protein must not scale with calories" is the load-bearing rule
 * in this whole file) and §7.5 "How meal portions follow".
 */

import { FLOORS, type FoodComponent, type Macros } from "./types";

export type DayCategory = "training" | "rest";

const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_CARB = 4;
const KCAL_PER_G_FAT = 9;

/** Adding calories: all of it goes to carbs, up to this many grams over baseline. */
const MAX_CARB_INCREASE_G = 75;

const CLAMP_MESSAGE = "That is as low as this plan goes safely.";

/** Kcal implied by a set of macro grams, via standard Atwater factors. */
export function macroKcal(macros: Pick<Macros, "protein" | "carbs" | "fat">): number {
  return (
    macros.protein * KCAL_PER_G_PROTEIN +
    macros.carbs * KCAL_PER_G_CARB +
    macros.fat * KCAL_PER_G_FAT
  );
}

function carbFloorFor(category: DayCategory): number {
  return category === "training" ? FLOORS.carbsTraining : FLOORS.carbsRest;
}

export type CalorieAdjustment = {
  macros: Macros;
  clamped: boolean;
  message?: string;
};

/**
 * Redistribute a change in daily calories across carbs and fat ONLY.
 * `baseline.protein` is carried through untouched — it never scales with
 * calories (PRD §7.5). `baseline.kcal` is the reference point the delta is
 * measured against; it need not equal `macroKcal(baseline)` if the caller is
 * also changing the protein baseline at the same time (see targets.ts).
 *
 * Adding calories (target > baseline): all to carbs, up to +75 g over
 * baseline; anything beyond that goes to fat. Uncapped on the way up.
 *
 * Removing calories (target < baseline): carbs down to the day-type floor
 * first, then fat down to its floor. Protein is never touched. If the
 * requested kcal still can't be reached once both floors are hit, the
 * result clamps at the floors and carries a `clamped` flag + message.
 */
export function adjustCalories(
  baseline: Macros,
  targetKcal: number,
  category: DayCategory
): CalorieAdjustment {
  const protein = baseline.protein;
  const deltaKcal = targetKcal - baseline.kcal;

  if (deltaKcal === 0) {
    return { macros: { ...baseline }, clamped: false };
  }

  if (deltaKcal > 0) {
    const carbCapKcal = MAX_CARB_INCREASE_G * KCAL_PER_G_CARB;
    const carbAddKcal = Math.min(deltaKcal, carbCapKcal);
    const carbs = baseline.carbs + carbAddKcal / KCAL_PER_G_CARB;
    const remainingKcal = deltaKcal - carbAddKcal;
    const fat = baseline.fat + remainingKcal / KCAL_PER_G_FAT;

    const roundedCarbs = Math.round(carbs);
    const roundedFat = Math.round(fat);
    return {
      macros: {
        protein,
        carbs: roundedCarbs,
        fat: roundedFat,
        kcal: macroKcal({ protein, carbs: roundedCarbs, fat: roundedFat }),
      },
      clamped: false,
    };
  }

  // deltaKcal < 0 — removing calories: carbs first, then fat, protein never.
  let remainingReduceKcal = -deltaKcal;

  const carbFloor = carbFloorFor(category);
  const carbCapacityKcal = Math.max(0, (baseline.carbs - carbFloor) * KCAL_PER_G_CARB);
  const carbReduceKcal = Math.min(remainingReduceKcal, carbCapacityKcal);
  const carbs = baseline.carbs - carbReduceKcal / KCAL_PER_G_CARB;
  remainingReduceKcal -= carbReduceKcal;

  const fatFloor = FLOORS.fat;
  const fatCapacityKcal = Math.max(0, (baseline.fat - fatFloor) * KCAL_PER_G_FAT);
  const fatReduceKcal = Math.min(remainingReduceKcal, fatCapacityKcal);
  const fat = baseline.fat - fatReduceKcal / KCAL_PER_G_FAT;
  remainingReduceKcal -= fatReduceKcal;

  const clamped = remainingReduceKcal > 1e-9;
  const roundedCarbs = Math.round(carbs);
  const roundedFat = Math.round(fat);

  return {
    macros: {
      protein,
      carbs: roundedCarbs,
      fat: roundedFat,
      kcal: macroKcal({ protein, carbs: roundedCarbs, fat: roundedFat }),
    },
    clamped,
    ...(clamped ? { message: CLAMP_MESSAGE } : {}),
  };
}

// ---------------------------------------------------------- portion scaling

function roundToNearest(qty: number, step: number): number {
  return Math.round(qty / step) * step;
}

/** The smallest amount of each unit a person serves; also the rounding step. */
export const SERVING_STEP: Record<FoodComponent["unit"], number> = {
  oz: 0.5, cup: 0.25, tbsp: 0.5, tsp: 0.5, whole: 1, pouch: 1, can: 1, g: 1, ml: 1,
};

/**
 * Round a scaled quantity to an amount a human can actually serve.
 * PRD §7.5 "How meal portions follow".
 *
 * Zero (or less, or not a number) stays 0: nothing was asked for, so nothing is served — a zero
 * whole/pouch/can used to round up to 1 (audit N5). A positive demand never rounds to 0: it floors
 * at the unit's smallest step, so 0.2 oz of a fat is 0.5 oz, not a component that silently
 * vanishes with its macros zeroed (audit N1). `g` and `ml` round to the nearest whole unit — not
 * covered by the PRD's rounding table, the least surprising default.
 */
export function roundToServing(qty: number, unit: FoodComponent["unit"]): number {
  if (!(qty > 0)) return 0;
  const step = SERVING_STEP[unit];
  if (step === undefined) return qty;
  return Math.max(step, roundToNearest(qty, step));
}

/**
 * A scaled portion, rounded to a serving, that never moves against the scale: the step floor
 * (roundToServing) can lift 0.4 oz × 0.5 to 0.5 oz, and a portion that grew while the day asked
 * for less would add the very macros the scale removed. Such a portion stays as it was instead.
 */
function scaledServing(qty: number, scaleFactor: number, unit: FoodComponent["unit"]): number {
  const rounded = roundToServing(qty * scaleFactor, unit);
  if (scaleFactor < 1 && rounded > qty) return qty;
  if (scaleFactor > 1 && rounded < qty) return qty;
  return rounded;
}

function scaleMacros(macros: Macros, ratio: number): Macros {
  const protein = Math.round(macros.protein * ratio);
  const carbs = Math.round(macros.carbs * ratio);
  const fat = Math.round(macros.fat * ratio);
  return { protein, carbs, fat, kcal: macroKcal({ protein, carbs, fat }) };
}

/**
 * Scale a meal's components for the day's targets. Only `role: "carb"` and
 * `role: "fat"` components move; `"protein"` and `"free"` components are
 * returned unchanged (as new objects — this module never mutates its
 * inputs — but with byte-identical values). PRD §7.5.
 *
 * The macro scaling ratio for a moved component is derived from its ACTUAL
 * rounded quantity change (not the raw scale factor), so a component's
 * macros stay internally consistent with the displayed portion size.
 */
export function scaleComponents(
  components: FoodComponent[],
  scaleFactor: number
): FoodComponent[] {
  return components.map((component) => {
    if (component.role !== "carb" && component.role !== "fat") {
      return { ...component, macros: { ...component.macros } };
    }

    const roundedQty = scaledServing(component.qty, scaleFactor, component.unit);
    // Zero stays zero (N5), and so do its macros: a 0-qty row never carries scaled numbers.
    const effectiveRatio = component.qty === 0 ? 0 : roundedQty / component.qty;

    return {
      ...component,
      qty: roundedQty,
      macros: scaleMacros(component.macros, effectiveRatio),
    };
  });
}

/**
 * Scale ONLY the protein components of a meal to the active target revision.
 * Keep this separate from `scaleComponents`: a calorie pin must never move
 * protein, while a newly derived protein target must resize protein portions.
 */
export function scaleProteinComponents(
  components: FoodComponent[],
  scaleFactor: number
): FoodComponent[] {
  return components.map((component) => {
    if (component.role !== "protein") {
      return { ...component, macros: { ...component.macros } };
    }

    const roundedQty = scaledServing(component.qty, scaleFactor, component.unit);
    // Zero stays zero (N5), and so do its macros: a 0-qty row never carries scaled numbers.
    const effectiveRatio = component.qty === 0 ? 0 : roundedQty / component.qty;

    return {
      ...component,
      qty: roundedQty,
      macros: scaleMacros(component.macros, effectiveRatio),
    };
  });
}
