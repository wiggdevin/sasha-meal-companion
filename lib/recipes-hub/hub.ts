/**
 * The recipe widget's pure rules: its quick chips and what each one asks, the ask box's rotating
 * examples, today's remaining macros and whether a recipe fits them, and when typed words are a
 * log ("I had two slices of the lasagna") rather than a question.
 *
 * Pure. No I/O.
 */

import type { CoachSuggestion } from "@/lib/coach/types";
import { RECIPE_MACROS, type RecipeCandidate, type RecipeMacroKey, type RecipeSearch } from "@/lib/recipe-catalog/types";
import type { Macros } from "@/lib/types";
import { illustrativeMealImage } from "@/lib/today/meal-art";
import { BALANCED_PLATE_IMAGE } from "@/lib/today/meal-art-rules";

export const HUB_CHIPS = [
  "Suggest a recipe", "High protein", "Under 30 min", "Comfort food", "Use what I have", "Build my own",
] as const;
export type HubChip = (typeof HUB_CHIPS)[number];
/** Every chip but "Build my own" is a coach ask. */
export type AskChip = Exclude<HubChip, "Build my own">;

const NEED: Record<AskChip, string> = {
  "Suggest a recipe": "Pick what fits best.",
  "High protein": "Prioritize protein.",
  "Under 30 min": "Only recipes ready in under 30 minutes.",
  "Comfort food": "Something comforting and hearty.",
  "Use what I have": "Use only foods already in my Favorites.",
};

export function chipPrompt(chip: AskChip): string {
  return `Suggest three recipes or meals I can have today that fit my remaining macros. ${NEED[chip]}`;
}

/**
 * The catalog list that answers a chip or a typed ask, shown before the coach's composed meals.
 * A chip gets a catalog list only when the catalog search can hold its constraint: "Under 30 min"
 * is `maxMinutes`, and "Suggest a recipe" claims no filter. The search has no protein floor, no
 * comfort tag and no Eats-only switch, so "High protein", "Comfort food" and "Use what I have" get
 * no list (null) rather than the same three unfiltered recipes under a chip that claims a filter
 * (2026-10-04 audit, MAJOR 5). Their coach ask still carries the constraint (chipPrompt).
 */
export function hubSearchFor(ask: { chip: AskChip } | { wish: string }): RecipeSearch | null {
  if ("wish" in ask) return { query: ask.wish.trim().slice(0, 120), limit: 3 };
  return CHIP_SEARCH[ask.chip];
}

const CHIP_SEARCH: Record<AskChip, RecipeSearch | null> = {
  "Suggest a recipe": { query: "", limit: 3 },
  "Under 30 min": { query: "", maxMinutes: 30, limit: 3 },
  "High protein": null,
  "Comfort food": null,
  "Use what I have": null,
};

/** The owner's own phrasings, rotated through the ask box's placeholder. */
export const ASK_EXAMPLES = [
  "I feel like Italian…",
  "Something hearty, it’s cold",
  "How much lasagna can I have?",
  "I really want steak",
] as const;

export function exampleAt(tick: number): string {
  return ASK_EXAMPLES[((tick % ASK_EXAMPLES.length) + ASK_EXAMPLES.length) % ASK_EXAMPLES.length];
}

/** What is left today, floored at zero. Null without a target: nothing can be said to fit. */
export function remainingMacros(day: { targets: Macros | null; consumed: Macros }): Macros | null {
  if (!day.targets) return null;
  const left = (key: keyof Macros) => Math.max(0, day.targets![key] - day.consumed[key]);
  return { kcal: left("kcal"), protein: left("protein"), carbs: left("carbs"), fat: left("fat") };
}

/** The kcal and protein left, as one pair that fits together: protein never claims more energy than
 *  is left (lib/plan/slot-share.ts remainingPool fits protein first the same way). Without this a
 *  day over its fat read "About 222 kcal · 73 g protein left today" (73 g is 292 kcal). */
export function remainingLine(left: Macros | null): string {
  // The cap itself is floored, not the rounded result: round(min(protein, kcal / 4)) can still
  // round up past the kcal left (73 g at 222 kcal: min is 55.5, rounds to 56, and 56 g is 224
  // kcal). Flooring the cap first keeps grams * 4 at or under kcal left (2026-10-05 audit, MINOR 6).
  const protein = left ? Math.min(left.protein, Math.floor(left.kcal / 4)) : 0;
  return left ? `About ${Math.round(left.kcal)} kcal · ${Math.round(protein)} g protein left today`
    : "Your targets appear once your profile is ready";
}

export type ServingFacts = { kcal: number | null; protein: number | null;
  carbs?: number | null; fat?: number | null };

/** One serving's four macros, or null where the catalog does not know the value. */
export function servingFacts(recipe: Pick<RecipeCandidate, "nutritionPerServing">): ServingFacts {
  const read = (key: string) => {
    const value = recipe.nutritionPerServing[key]?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return { kcal: read("kcal"), protein: read("protein"), carbs: read("carbs"), fat: read("fat") };
}

export type MacroFact = { value: number | null; estimated: boolean };

/** One serving's four macros for the detail's macro strip; an unknown value stays null, never 0. */
export function macroFacts(recipe: Pick<RecipeCandidate, "nutritionPerServing">): Record<RecipeMacroKey, MacroFact> {
  return Object.fromEntries(RECIPE_MACROS.map((key) => {
    const evidence = recipe.nutritionPerServing[key];
    const value = evidence && evidence.status !== "unknown" && typeof evidence.value === "number"
      && Number.isFinite(evidence.value) ? evidence.value : null;
    return [key, { value, estimated: value !== null && evidence?.status === "estimated" }];
  })) as Record<RecipeMacroKey, MacroFact>;
}

const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

/** The share of a serving's energy one macro carries (4 / 4 / 9 kcal per gram), 0–1; null if unknown. */
export function energyShare(facts: Record<RecipeMacroKey, MacroFact>, key: keyof typeof KCAL_PER_GRAM): number | null {
  const grams = facts[key].value;
  const kcal = facts.kcal.value;
  if (grams === null || kcal === null || kcal <= 0) return null;
  return Math.min(1, Math.max(0, (grams * KCAL_PER_GRAM[key]) / kcal));
}

/** The limits a serving can go over. Protein is the day's floor, not a cap: more never fails. */
type FitMacro = "kcal" | "fat" | "carbs";

export type Fit = { kind: "fits" } | { kind: "over"; by: number; macro: FitMacro } | { kind: "unknown" };

/**
 * Whether one serving fits what is left today: its kcal, fat and carbs each within what is left
 * (2026-10-04 audit, MINOR 9: a serving inside the kcal and far over the fat read "Fits today").
 * Any known value over says so, kcal first. An unknown value, protein included, never reads as a fit.
 */
export function fitToday(facts: ServingFacts, left: Macros | null): Fit {
  // Protein is a floor, never a cap, but a serving whose protein is unknown cannot be called a fit.
  if (!left || facts.kcal === null || facts.protein === null) return { kind: "unknown" };
  const limits: FitMacro[] = ["kcal", "fat", "carbs"];
  for (const macro of limits) {
    const value = facts[macro];
    const over = value === null || value === undefined ? 0 : Math.round(value - left[macro]);
    if (over > 0) return { kind: "over", by: over, macro };
  }
  return limits.every((macro) => typeof facts[macro] === "number") ? { kind: "fits" } : { kind: "unknown" };
}

export function fitLabel(fit: Fit): string | null {
  if (fit.kind === "fits") return "Fits today";
  if (fit.kind === "over") return fit.macro === "kcal" ? `~${fit.by} kcal over` : `~${fit.by} g ${fit.macro} over`;
  return null;
}

/**
 * Words that report something already eaten: "I had two slices of the lasagna", "I just ate a
 * banana", "log an apple". These skip the coach and go straight to a Log it confirmation. A question
 * ("how much lasagna can I have?") is never one.
 */
export function eatenStatement(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.endsWith("?")) return null;
  const match = /^(?:i\s+(?:just\s+)?(?:had|ate)|log(?:\s+that)?)\s+(.+)$/i.exec(trimmed);
  return match ? match[1].replace(/[.!]+$/, "").trim() || null : null;
}

/**
 * The portion a coach answer sized, as words the log path can read ("350 g lasagna"): the grounded
 * suggestions with grams. Null when the answer named no portion.
 */
export function portionToLog(suggestions: readonly CoachSuggestion[]): string | null {
  const sized = suggestions.filter((item) => item.verdict !== "blocked" && item.grams && item.grams > 0);
  if (sized.length === 0) return null;
  return sized.slice(0, 4).map((item) => `${Math.round(item.grams!)} g ${item.name}`).join(", ");
}

/**
 * "How much lasagna can I have?", "how many slices can I eat": an ask whose answer is a portion.
 * "Is there anything I can have?" is a request for options, not a portion.
 */
export function portionQuestion(text: string): boolean {
  return /\bhow\s+(?:much|many|big)\b/i.test(text);
}

/**
 * A card photo for a catalog recipe: its name first ("Beef lasagna" is the pasta photo), then its
 * ingredients, else null: the card shows the app's own olive art, never a plate of food the recipe
 * does not contain (DESIGN.md meal card rule, 2026-10-04).
 */
export function recipePhoto(recipe: Pick<RecipeCandidate, "name" | "ingredients">): string | null {
  const byName = illustrativeMealImage(recipe.name, []);
  if (byName && byName !== BALANCED_PLATE_IMAGE) return byName;
  const byFoods = illustrativeMealImage(recipe.name, recipe.ingredients);
  return byFoods && byFoods !== BALANCED_PLATE_IMAGE ? byFoods : null;
}
