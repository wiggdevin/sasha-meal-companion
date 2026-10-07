/**
 * A recipe's meal type, and the meal a request names (Phase 17 O4,
 * docs/specs/phase-17-meal-occasion.md, acceptance 10).
 *
 * Search used to strip "breakfast", "lunch", "dinner" and "snack" from a request, so "easy
 * breakfast" ranked dinners beside breakfasts. A meal word is now an occasion, and recipes whose
 * dish tags name that meal come first. It is a preference, never a filter: a recipe tagged for
 * another meal, or for none, is still offered after the ones that match (acceptance 11).
 *
 * The request's meal is read by the one shared parser (lib/meals/occasion-phrase.ts). The same
 * scoring places recipes into a period plan's slots, by each slot's clock occasion
 * (lib/meals/occasion.ts occasionAt).
 *
 * Pure. No I/O.
 */

import type { Occasion } from "@/lib/meals/occasion";
import { parseOccasionPhrase, type MealWord } from "@/lib/meals/occasion-phrase";

export type { MealWord } from "@/lib/meals/occasion-phrase";

/** Dish tags that name a meal. */
const TAG_OCCASION: Readonly<Record<string, MealWord>> = {
  breakfast: "breakfast", brunch: "breakfast",
  lunch: "lunch",
  dinner: "dinner", supper: "dinner",
  snack: "snack", snacks: "snack",
};

/**
 * The meal a request names ("easy breakfast" → breakfast), or null when it names none. An explicit
 * "for/at/as <meal>" phrase wins over a meal word inside a dish name: "breakfast burrito for
 * dinner" is dinner (lib/meals/occasion-phrase.ts).
 */
export function wishOccasion(text: string | null | undefined): MealWord | null {
  return parseOccasionPhrase(text).occasion;
}

/** The meals a recipe's own dish tags name; empty when it names none. */
export function recipeOccasions(recipe: { dishTags: readonly string[] }): Set<MealWord> {
  const found = new Set<MealWord>();
  for (const tag of recipe.dishTags) {
    const occasion = TAG_OCCASION[tag.trim().toLowerCase()];
    if (occasion) found.add(occasion);
  }
  return found;
}

/**
 * How well a recipe suits an occasion, 0–1:
 *   1    its tags name that meal
 *   0.5  lunch for dinner (or the reverse), or a lunch/dinner recipe for an overnight meal:
 *        all three share the savoury-main plate (lib/meals/templates.ts)
 *   0.25 its tags name no meal at all: unknown, not wrong
 *   0    its tags name only other meals (a breakfast recipe for dinner)
 */
export function occasionFit(recipe: { dishTags: readonly string[] }, occasion: Occasion): number {
  const tags = recipeOccasions(recipe);
  if (tags.size === 0) return 0.25;
  if (occasion !== "other" && tags.has(occasion)) return 1;
  const mains = occasion === "lunch" || occasion === "dinner" || occasion === "other";
  if (mains && (tags.has("lunch") || tags.has("dinner"))) return 0.5;
  return 0;
}
