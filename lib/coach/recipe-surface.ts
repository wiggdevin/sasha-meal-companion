/**
 * Guidance for a turn from the Foods page recipe widget (`surface: "recipes"`). It rides in the
 * transcript just before the user's message, only on that surface, so the system prompt (and its
 * golden test) stays byte-identical for every other turn.
 *
 * The owner's asks this block is written for (2026-10-03): "I feel like Italian, is there anything
 * I can have without going over?", "I really want steak", "a friend is coming over and cooking
 * lasagna, how much can I eat?", "it's cold outside, any hearty soup recipes?".
 *
 * Pure. No I/O.
 */

import type { CoachSurface } from "@/lib/coach/types";

export const RECIPE_SURFACE_GUIDANCE: readonly string[] = [
  "RECIPE WIDGET — this turn comes from the recipe widget on the Foods page:",
  "- A dish, cuisine, craving or mood (\"Italian\", \"steak\", \"something hearty, it's cold\"):",
  "  call suggest_options with kind recipe and a short wish for complete recipes, and",
  "  suggest_options with kind meal and fitRemaining true for meal ideas. Both must fit what",
  "  YOUR DAY says is still to eat today. Your text is one or two short sentences beside the cards.",
  "- A portion question about a named dish someone else makes or serves (\"a friend is cooking",
  "  lasagna, how much can I eat?\"): size a portion from YOUR DAY's remaining calories and",
  "  protein. Give it in household terms with grams and kcal, then say what one more portion",
  "  does, for example: \"About 1 slice (~350 g, ~520 kcal) fits what you have left; 2 slices",
  "  puts you ~300 kcal over.\" Use search_foods for the dish's typical values when you need them.",
  "  Say plainly that it is an estimate, because the recipe is not known. Put the dish and the",
  "  grams of the portion that fits in `suggestions`.",
  "- With no targets or remaining numbers in YOUR DAY, say you cannot size it to their day yet",
  "  and give one typical serving as an estimate.",
  "- Never say a dish is safe for an allergy, intolerance or condition: nobody can know what is in",
  "  someone else's cooking. When allergens are recorded above, say to check the ingredients.",
  "- Emit NO actions on this surface. The widget logs only when the person taps Log it.",
];

/** The transcript lines a turn's surface adds; none for Coach chat or the Plan sheet. */
export function surfaceGuidance(surface: CoachSurface | undefined): readonly string[] {
  return surface === "recipes" ? [RECIPE_SURFACE_GUIDANCE.join("\n")] : [];
}
