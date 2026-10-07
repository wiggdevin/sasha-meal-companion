/**
 * The words every surface uses for an honest count (calculation audit #21): a serving of a recipe
 * with unmeasured ingredients sums only the measured ones, so its calories are a lower bound, and a
 * day that holds one has "at least" eaten and "at most" left. One place for the wording, so the
 * card, the Day card, the recipe list and the save confirmations all say it the same way.
 *
 * A partial count is never off-plan: it is a neutral note beside the off-plan mark, never in it.
 */
import type { CommitResult } from "@/lib/log-commit-client";

/** exact: the whole count · at-least: a lower bound · at-most: an upper bound. */
export type Bound = "exact" | "at-least" | "at-most";

/** The neutral note a partly measured entry carries beside its macros. */
export const PARTIAL_NOTE = "partial";
/** The day's nutrients card, when a logged recipe serving was only partly measured. */
export const PARTIAL_DAY_LINE = "Includes a partly measured recipe.";
/** A save whose partial check could not run (`nutrition_unchecked`): said once, never stored. */
export const NUTRITION_UNCHECKED_COPY = "Saved. Nutrition not fully checked.";

/** "at least", "at most", or nothing for an exact count. */
export function boundWords(bound: Bound | undefined): string {
  return bound === "at-least" ? "at least" : bound === "at-most" ? "at most" : "";
}

/** The same words opening a label: "At least". */
export function boundLabel(bound: Bound | undefined): string {
  const words = boundWords(bound);
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** "at least 420 kcal" — the words, then the phrase, one space between. */
export function withBound(phrase: string, bound: Bound | undefined): string {
  const words = boundWords(bound);
  return words ? `${words} ${phrase}` : phrase;
}

/** What was eaten: a lower bound once a partly measured serving is in it. */
export function eatenBound(partial: boolean): Bound {
  return partial ? "at-least" : "exact";
}

/**
 * What is left of a target. With a lower-bound intake, what is left is at most the figure, and an
 * overshoot is at least the figure.
 */
export function balanceBound(partial: boolean, over: boolean): Bound {
  if (!partial) return "exact";
  return over ? "at-least" : "at-most";
}

/** A recipe serving: complete numbers are exact, anything else a lower bound. */
export function servingBound(nutritionComplete: boolean): Bound {
  return nutritionComplete ? "exact" : "at-least";
}

/**
 * Grams of protein a shopping choice falls short by (`proteinGapGrams` below 0), whole. Null when
 * the gap is null, zero, positive, or rounds to nothing: "0g short" is not a shortfall.
 */
export function proteinShortGrams(gap: number | null | undefined): number | null {
  if (typeof gap !== "number" || !Number.isFinite(gap) || gap >= 0) return null;
  const grams = Math.round(-gap);
  return grams > 0 ? grams : null;
}

/** True when a commit landed but its partial check could not run (`nutrition_unchecked`). */
export function commitNutritionUnchecked(result: CommitResult | null | undefined): boolean {
  return result?.status === "ok" && "nutrition_unchecked" in result && result.nutrition_unchecked === true;
}
