import type { CatalogRecipe, RecipeCandidate, RecipeSearch } from "@/lib/recipe-catalog/types";
import type { RecipeEligibilityInput } from "@/lib/recipes/eligibility";
import { withRecipeEligibility } from "@/lib/recipes/eligibility";
import { dishSearchTerms, namesTerm, searchWords } from "@/lib/recipe-catalog/query";
import { normalizeCuisineFamily } from "@/lib/recipe-catalog/cuisine";
import { occasionFit } from "@/lib/recipes/occasion";
import { recipeTastePoints, type TasteValues } from "@/lib/meals/preference";

export type CandidatePreferences = {
  /** Explicit favorites from the existing favorites entity, never all Eats. */
  favoriteRecipeIds?: readonly string[];
  favoriteFoodRefIds?: readonly string[];
  /** Only rows whose user-chosen provenance is established. */
  usualFoodRefIds?: readonly string[];
  recentRecipeIds?: readonly string[];
  targetKcal?: number | null;
  /**
   * D8's caller table ("Recipe search, the coach and the shopping planner"): when the account's
   * quantized pref-2 values are available, `RECIPE_TASTE_POINTS × (T − 1)` over the recipe's
   * ingredients BY GRAMS replaces the favorite-food `+1` and the unused "usual" `+0.25` terms
   * below (the favorite-RECIPE `+3` stays either way). Absent (every caller today — no account
   * taste computation is wired up to recipe search yet): the original terms, unchanged.
   */
  taste?: TasteValues;
};

/** The same normalized identity `lib/meals/parts.ts`'s `foodKey` gives a plate row's food, built
 *  from an authored ingredient line's own name (recipe ingredients carry no `Food` object). */
const ingredientKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
export type CandidateResult = {
  candidates: RecipeCandidate[];
  excluded: { revisionId: string; eligibility: RecipeCandidate["eligibility"] }[];
  noResultReasons: string[];
  /**
   * Whether some returned recipe matches every word of the query. False when the query names words
   * and no recipe carries them all: the list is then the closest recipes ("No exact match").
   */
  exactMatch: boolean;
};

const words = searchWords;

/** The words a recipe is searched by: its name, cuisine, dish tags and ingredient names. */
const indexedWords = (recipe: CatalogRecipe): string[] => words([recipe.name, recipe.cuisine ?? "",
  ...recipe.dishTags, ...recipe.ingredients.map((ingredient) => ingredient.name)].join(" "));

/** Each query word a recipe carries outranks the requested meal (at most 200) and everything else. */
const WORD_WEIGHT = 1000;

/**
 * Search ranks; only the explicit filters (cuisine, time, effort, exclusions, eligibility) remove a
 * recipe (O4a review round 3). Query words are scored, never required: a recipe carrying every
 * word comes first, then those carrying fewer, so a word no recipe knows ("7pm", "pork") can never
 * empty the list. `exactMatch` says whether any recipe carried them all.
 */
export function findRecipeCandidates(
  recipes: readonly CatalogRecipe[], search: RecipeSearch,
  eligibility: RecipeEligibilityInput | ((recipe: CatalogRecipe) => RecipeEligibilityInput),
  preferences: CandidatePreferences = {},
): CandidateResult {
  const query = [...new Set(dishSearchTerms(search.query))];
  let exactMatch = query.length === 0;
  const favoriteRecipes = new Set(preferences.favoriteRecipeIds ?? []);
  const favoriteFoods = new Set(preferences.favoriteFoodRefIds ?? []);
  const usual = new Set(preferences.usualFoodRefIds ?? []);
  const recent = new Set(preferences.recentRecipeIds ?? []);
  const excludedRefs = new Set(search.excludedFoodRefIds ?? []);
  const excluded: CandidateResult["excluded"] = [];
  const ranked: { candidate: RecipeCandidate; score: number }[] = [];
  for (const recipe of recipes) {
    const searchable = indexedWords(recipe);
    if (search.cuisine && !words(normalizeCuisineFamily(search.cuisine)).every((word) =>
      words(normalizeCuisineFamily(recipe.cuisine ?? "")).includes(word))) continue;
    if (search.maxMinutes !== undefined
      && (recipe.totalMinutes === null || recipe.totalMinutes > search.maxMinutes)) continue;
    if (search.effort === "none" && recipe.effort !== "none") continue;
    if (search.effort === "minimal" && recipe.effort === "standard") continue;
    if (recipe.ingredients.some((ingredient) => ingredient.foodRefId
      && excludedRefs.has(ingredient.foodRefId))) continue;
    const candidate = withRecipeEligibility(recipe,
      typeof eligibility === "function" ? eligibility(recipe) : eligibility);
    if (candidate.eligibility.status !== "eligible") {
      excluded.push({ revisionId: recipe.revisionId, eligibility: candidate.eligibility });
      continue;
    }
    const matched = query.filter((word) => searchable.some((term) => namesTerm(term, word))).length;
    if (query.length > 0 && matched === query.length) exactMatch = true;
    const exactName = query.length > 0 && query.every((word) => words(recipe.name).includes(word));
    const kcal = recipe.nutritionPerServing.kcal;
    const macroFit = preferences.targetKcal && kcal?.status !== "unknown" && kcal?.value != null
      ? Math.max(0, 1 - Math.abs(kcal.value - preferences.targetKcal) / preferences.targetKcal) : 0;
    const refs = recipe.ingredients.map((ingredient) => ingredient.foodRefId);
    // A named meal leads the order ("easy breakfast" → breakfasts first) but filters nothing.
    const occasion = search.occasion ? occasionFit(recipe, search.occasion) * 200 : 0;
    const tasteTerm = preferences.taste
      ? recipeTastePoints(recipe.ingredients.map((ingredient) => ({
        key: ingredientKey(ingredient.name), amount: ingredient.grams ?? 0,
      })), preferences.taste, search.occasion ?? null)
      : refs.filter((ref) => ref && favoriteFoods.has(ref)).length
        + refs.filter((ref) => ref && usual.has(ref)).length * 0.25;
    const score = matched * WORD_WEIGHT + occasion + (exactName ? 100 : 0) + macroFit * 10
      + (favoriteRecipes.has(recipe.recipeId) ? 3 : 0) + tasteTerm
      - (recent.has(recipe.recipeId) ? 2 : 0);
    ranked.push({ candidate, score });
  }
  ranked.sort((a, b) => b.score - a.score
    || a.candidate.name.localeCompare(b.candidate.name)
    || a.candidate.revisionId.localeCompare(b.candidate.revisionId));
  // Search/Coach default to three cards; the authenticated period planner asks
  // for the full bounded eligible pool so strict baskets see every pilot option.
  const limit = Math.max(0, Math.min(64, search.limit ?? 3));
  return {
    candidates: ranked.slice(0, limit).map((row) => row.candidate),
    excluded,
    exactMatch,
    noResultReasons: ranked.length ? [] : excluded.length
      ? summarizeExclusions(excluded)
      : ["No complete recipe matches the requested dish, cuisine, time, and effort."],
  };
}

/** A bounded user-facing summary; ingredient evidence remains in detail/diagnostics. */
export function summarizeExclusions(excluded: CandidateResult["excluded"]): string[] {
  const all = excluded.flatMap((row) => row.eligibility.reasons);
  const blocked = all.filter((item) => item.code === "avoid_list" || item.code === "policy_block"
    || item.code === "custom_cuisine");
  const unknown = all.filter((item) => item.code === "category_evidence"
    || item.code === "facet_evidence" || item.code === "policy_unknown"
    || item.code === "unknown_identity");
  const summary: string[] = [];
  if (blocked.length) summary.push("Some recipes conflict with your Avoid list or food rules.");
  if (unknown.length) summary.push("Some ingredients need preference or restriction evidence before they can be recommended.");
  if (!summary.length) summary.push("No complete recipe is available for these filters.");
  return summary;
}
