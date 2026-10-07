import type { ComposedItem, ComposedMeal } from "@/lib/coach/compose";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import { fitNote, fitsTarget, type MealMacros } from "@/lib/coach/compose-size";
import type { SuggestionCandidate } from "@/lib/coach/suggest-candidates";
import {
  filterSuggestionCandidates, loadSuggestionEvidence, suggestionFoodIdentity,
  type SuggestionEvidence, type SuggestionEvidencePort,
} from "@/lib/coach/suggest-policy";
import { facetOutcome, FACET_RULES, type PolicyPreferenceFlag }
  from "@/lib/policy/facet-rules";
import { evaluatePolicy, type ConstraintProfile, type PolicyMark }
  from "@/lib/policy/constraints";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import { facetPredicate } from "@/lib/policy/reason-words";

export type RecipeRefusal = {
  foodRefId: string;
  name: string;
  verdict: "blocked" | "unverified";
  facet: string;
  preference: PolicyPreferenceFlag | "food_preferences" | "human_food" | "avoid_list";
  message: string;
};

export type RecipePolicyResult = { items: ComposedItem[]; refusals: RecipeRefusal[] };
export type RecipePolicyOptions = {
  evidence?: SuggestionEvidence;
  evidencePort?: SuggestionEvidencePort;
  /** Test seam: an injected compose port owns its allowed verdicts; non-allowed still fail closed. */
  acceptAllowedGrounding?: boolean;
};
export type RecipeActionPolicyResult = { actions: CoachAction[]; refusals: string[] };
export type FilteredRecipeMeal = {
  /** Null means every ingredient was refused, so no recipe card may be emitted. */
  meal: ComposedMeal | null;
  /** The exact refusal copy returned on the model-facing tool result. */
  refusals: string[];
};

/** The single recipe reject hook; its decision delegates to C4a's candidate evaluator. */
export function rejectRecipeIngredients(
  userId: string,
  items: readonly ComposedItem[],
  profile: ConstraintProfile,
  options?: RecipePolicyOptions,
): Promise<RecipePolicyResult> {
  return filterRecipeIngredients(userId, items, profile, options);
}

/** The exact payload handed back to the model after the food-ideas hydrator runs. */
export function recipeToolResult(data: unknown, refusals: readonly string[]): unknown {
  if (refusals.length === 0) return data;
  return typeof data === "object" && data !== null
    ? { ...data, refusals: [...refusals] }
    : { data, refusals: [...refusals] };
}

const PREFERENCE_COPY: Record<PolicyPreferenceFlag, string> = {
  vegetarian: "vegetarian", vegan: "vegan", pescatarian: "pescatarian",
  no_pork: "no-pork", no_beef: "no-beef", no_shellfish: "no-shellfish",
  no_eggs: "egg-free", no_soy: "no-soy", no_peanuts: "peanut-free",
  low_fodmap: "low-FODMAP", halal: "halal", kosher: "kosher",
};

/** Allergen and category facets; the diet and religious ones (meat, pork, alcohol …) come from
 *  lib/policy/reason-words.ts so every surface says them the same way. */
const FACET_COPY: Record<string, string> = {
  shellfish: "contains shellfish", contains_gluten: "contains gluten", contains_egg: "contains egg",
  contains_peanut: "contains peanuts", contains_tree_nut: "contains tree nuts",
  contains_soy: "contains soy", contains_sesame: "contains sesame",
  onion_garlic: "contains onion or garlic", beans: "contains beans",
  simple_sugars: "contains simple sugars", raw_cruciferous: "is raw cruciferous",
  raw_leafy_greens: "is a raw leafy green",
};

/**
 * The single recipe reject boundary. The allow/reject decision is C4a's candidate evaluator,
 * applied to one ingredient at a time so one refusal never discards the rest of the recipe.
 * `evaluatePolicy` is read only to explain that decision in plain words; it does not gate again.
 */
export async function filterRecipeIngredients(
  userId: string,
  items: readonly ComposedItem[],
  profile: ConstraintProfile,
  options: RecipePolicyOptions = {},
): Promise<RecipePolicyResult> {
  const evidence = options.evidence ?? await (options.evidencePort ?? loadSuggestionEvidence)(
    userId, items, { needsNoCook: false, facets: profileRuleFacets(profile.profileRules) },
  );
  const kept: ComposedItem[] = [];
  const refusals: RecipeRefusal[] = [];

  for (const [index, item] of items.entries()) {
    if (options.acceptAllowedGrounding && item.verdict === "allowed") {
      kept.push(item);
      continue;
    }
    const filtered = filterSuggestionCandidates(
      [candidateFor(item, index)], evidence, profile, false,
    );
    if (filtered.candidates.length === 1) kept.push(item);
    else refusals.push(explainRefusal(item, evidence, profile));
  }
  return { items: kept, refusals };
}

/** Apply recipe-only policy to a composed tool result; logging keeps its mark-only path. */
export async function filterRecipeMeal(
  userId: string,
  meal: ComposedMeal,
  profile: ConstraintProfile,
  options?: RecipePolicyOptions,
): Promise<FilteredRecipeMeal> {
  const filtered = await rejectRecipeIngredients(userId, meal.items, profile, options);
  const refusals = filtered.refusals.map((refusal) => refusal.message);
  if (filtered.items.length === 0) return { meal: null, refusals };
  if (options?.acceptAllowedGrounding && filtered.items.length === meal.items.length) {
    return { meal, refusals };
  }
  const totals = mealTotals(filtered.items);
  const fits = fitsTarget(totals, meal.target);
  return {
    meal: {
      ...meal,
      items: filtered.items,
      totals,
      flagged: filtered.items.filter((item) => item.verdict === "blocked")
        .map((item) => item.name),
      fitsTarget: fits,
      fitNote: fits ? null : fitNote(totals, meal.target),
      ...(refusals.length > 0 ? { refusals } : {}),
    },
    refusals,
  };
}

function mealTotals(items: readonly ComposedItem[]): MealMacros {
  return items.reduce((total, item) => ({
    kcal: total.kcal + item.macros.kcal,
    protein: Math.round((total.protein + item.macros.protein) * 10) / 10,
    carbs: Math.round((total.carbs + item.macros.carbs) * 10) / 10,
    fat: Math.round((total.fat + item.macros.fat) * 10) / 10,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

/**
 * Ground final `save_recipe` actions with the same cache-only evidence as recipe composition.
 * Only allowed items stay on a surviving action; exact server refusals travel beside them so the
 * client confirmation gate never has to invent a policy reason.
 */
export async function filterRecipeActions(
  userId: string,
  actions: readonly CoachAction[],
  profile: ConstraintProfile,
  options: RecipePolicyOptions = {},
): Promise<RecipeActionPolicyResult> {
  const recipes = actions.filter((action) => action.kind === "save_recipe");
  if (recipes.length === 0) return { actions: [...actions], refusals: [] };
  const composed = recipes.flatMap((action) => action.items.map(asComposedItem));
  const evidence = options.evidence ?? await (options.evidencePort ?? loadSuggestionEvidence)(
    userId, composed, { needsNoCook: false, facets: profileRuleFacets(profile.profileRules) },
  );
  const keptActions: CoachAction[] = [];
  const messages: string[] = [];

  for (const action of actions) {
    if (action.kind !== "save_recipe") {
      keptActions.push(action);
      continue;
    }
    const checked = await filterRecipeIngredients(userId, action.items.map(asComposedItem), profile,
      { evidence });
    const refusalByItem = new Map(checked.refusals.map((refusal) => [
      recipeItemKey(refusal.foodRefId, refusal.name), refusal,
    ]));
    const checkedItems = action.items.map((item) => ({
      ...item,
      verdict: refusalByItem.get(recipeItemKey(item.foodRefId, item.name))?.verdict ?? item.verdict,
    })) as GroundedActionItem[];
    const refusals = checked.refusals.map((refusal) => refusal.message);
    messages.push(...refusals);
    // A recipe is the dish its ingredients make. If any ingredient fails the account's rules the
    // whole save is refused with the reasons; dropping the item and saving the rest under the same
    // name would silently store a different dish (GPT-6 Sol audit, 2026-10-04, finding B2).
    if (checkedItems.some((item) => item.verdict !== "allowed")) {
      if (refusals.length === 0) {
        messages.push(`I didn't save ${action.name ?? "that recipe"} — one of its ingredients `
          + "can't be checked against your food rules yet.");
      }
      continue;
    }
    keptActions.push({ ...action, items: checkedItems, flagged: [] });
  }
  return { actions: keptActions, refusals: messages };
}

function asComposedItem(item: GroundedActionItem): ComposedItem {
  return { ...item, macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } };
}

function recipeItemKey(foodRefId: string, name: string): string {
  return `${foodRefId}\u0000${name}`;
}

function candidateFor(item: ComposedItem, index: number): SuggestionCandidate {
  const meal: ComposedMeal = {
    wish: "", slot: null, items: [item], totals: item.macros, target: item.macros,
    flagged: [], fitsTarget: true,
  };
  return { meal, fit: 1, index };
}

function explainRefusal(
  item: ComposedItem,
  evidence: SuggestionEvidence,
  profile: ConstraintProfile,
): RecipeRefusal {
  const facts = evidence.byIdentity[suggestionFoodIdentity(item)];
  const policy = evaluatePolicy(profile, {
    foodRefId: item.foodRefId,
    allergenTags: facts?.allergenTags ?? null,
    allergenEvidence: facts?.allergenEvidence ?? {},
    checkedAllergens: facts?.checkedAllergens ?? [],
    ingredientsText: facts?.ingredientsText ?? null,
    ingredientsTextIsLabel: facts?.ingredientsTextIsLabel,
    // finding (r5): the one remaining evaluatePolicy call site missing the food's own name — the
    // r4 BLOCK #8 fix reached checkItem and every other site but not this one, so a name-only
    // pregnancy/tuna match (§9 R1) fell back to the generic "food preferences" refusal copy.
    foodName: facts?.foodName ?? null,
    foodBrand: facts?.foodBrand ?? null,
    category: facts?.policyCategories ?? null,
    onEatsList: facts?.onEatsList === true,
    onAvoidList: facts?.onAvoidList === true,
    preferenceFlags: evidence.preferenceFlags,
    facets: facts?.facets ?? {}, attestedFacets: facts?.attestedFacets,
    facetAction: "exclude",
    profileRules: profile.profileRules,
  });
  const human = facetOutcome("human_food", facts?.facets.human_food?.p, "exclude");
  const verdict = policy.verdict === "blocked" || human === "absent" || item.verdict === "blocked"
    ? "blocked" as const : "unverified" as const;
  const mark = markForVerdict(policy.marks ?? [], verdict);
  const facet = mark?.facet ?? (human !== "present" ? "human_food" : "food_preferences");
  const preference = preferenceFor(facet, evidence.preferenceFlags)
    ?? (facet === "avoid_list" ? "avoid_list" : facet === "human_food"
      ? "human_food" : "food_preferences");
  // Phase 13 §5: an allergen the account avoids speaks in the card's own words.
  const finding = mark?.source === "floor"
    ? policy.allergens?.find((candidate) => candidate.allergen === mark.facet) : undefined;
  return {
    foodRefId: item.foodRefId, name: item.name, verdict, facet, preference,
    message: finding
      ? verdict === "blocked"
        ? `Skipped ${item.name}: ${finding.text.charAt(0).toLowerCase()}${finding.text.slice(1)}.`
        : `Cannot verify ${item.name}: ${finding.text.charAt(0).toLowerCase()}${
          finding.text.slice(1)} — marked Not verified.`
      : refusalMessage(item.name, verdict, facet, preference),
  };
}

function markForVerdict(marks: readonly PolicyMark[], verdict: RecipeRefusal["verdict"]) {
  const wanted = verdict === "blocked" ? "present" : "unknown";
  return marks.find((mark) => mark.outcome === wanted);
}

function preferenceFor(
  facet: string,
  flags: readonly PolicyPreferenceFlag[],
): PolicyPreferenceFlag | undefined {
  return flags.find((flag) => FACET_RULES[flag].some((rule) => rule.facet === facet));
}

function refusalMessage(
  name: string,
  verdict: RecipeRefusal["verdict"],
  facet: string,
  preference: RecipeRefusal["preference"],
): string {
  if (verdict === "unverified") {
    if (preference === "human_food") {
      return `Cannot verify ${name} as human food — marked Not verified.`;
    }
    if (preference === "food_preferences") {
      return `Cannot verify ${name} for your food preferences — marked Not verified.`;
    }
    if (preference === "avoid_list") {
      return `Cannot verify ${name} against your Avoid list — marked Not verified.`;
    }
    return `Cannot verify ${name} for your ${PREFERENCE_COPY[preference]} preference — marked Not verified.`;
  }
  if (preference === "avoid_list") return `Skipped ${name}: on your Avoid list.`;
  if (preference === "human_food") return `Skipped ${name}: not verified as human food.`;
  if (preference === "food_preferences") {
    return `Skipped ${name}: blocked by your food preferences.`;
  }
  const reason = facetPredicate(facet) ?? FACET_COPY[facet] ?? facet.replaceAll("_", " ");
  return `Skipped ${name}: ${reason} (your ${PREFERENCE_COPY[preference]} preference).`;
}
