import type { CatalogRecipe, RecipeCandidate, RecipeEligibility } from "@/lib/recipe-catalog/types";
import {
  evaluatePolicy, type ConstraintProfile, type PolicyEvidence,
} from "@/lib/policy/constraints";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { dbFood } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import type { RecipeIngredient } from "@/lib/recipe-catalog/types";
import { isCustomRule, matchesRule } from "@/lib/policy/custom-rules";
import { wholeFoodNameForWording } from "@/lib/recipes/whole-food-wording";
import { reasonFragment } from "@/lib/policy/reason-words";

export type RecipeEligibilityInput = {
  profile: ConstraintProfile;
  /** Revision-specific food evidence loaded for this account. Never infer it from Eats or logs. */
  evidenceBySeq?: Readonly<Record<number, Partial<PolicyEvidence>>>;
  explicitAvoidFoodRefIds?: readonly string[];
  /** Account-scoped Avoid identities and names, loaded beside the ref marks. */
  explicitAvoidFoodDbIds?: readonly string[];
  explicitAvoidNames?: readonly string[];
  preferenceFlags?: readonly PolicyPreferenceFlag[];
};

const reason = (code: string, message: string, ingredientSeq?: number) =>
  ({ code, message, ...(ingredientSeq === undefined ? {} : { ingredientSeq }) });

/**
 * 2026-10-03: the one name whole-food clearance may read for a recipe line: its catalog row's own
 * description (or the bundled USDA row's), and only when lib/recipes/whole-food-wording.ts finds
 * the wording names that same plain food. The joined name still drives every escalation.
 */
export function wholeFoodNameFor(ingredient: RecipeIngredient,
  catalogDescription: string | null | undefined): string | null {
  const bundled = ingredient.foodDbId ? dbFood(ingredient.foodDbId) : undefined;
  return wholeFoodNameForWording(ingredient.name, catalogDescription
    || (bundled && !bundled.sr.startsWith("label:") ? bundled.sr : null));
}

export function hasCanonicalIngredientIdentity(ingredient: RecipeIngredient): boolean {
  return Boolean((ingredient.foodRefId && ingredient.catalogFoodRevisionId !== null)
    || (ingredient.foodDbId && dbFood(ingredient.foodDbId)));
}

/** One decision for both recipe search and planning. Every required line stays in the recipe. */
export function recipeEligibility(
  recipe: CatalogRecipe, input: RecipeEligibilityInput,
): RecipeEligibility {
  const reasons: RecipeEligibility["reasons"] = [];
  if (recipe.publicationState !== "published") {
    reasons.push(reason("not_published", "This recipe revision is not available for new plans."));
  }
  if (recipe.source.rightsKind === "link_only" || !recipe.source.rightsRecord.trim()) {
    reasons.push(reason("rights", "Complete recipe content is not permitted here."));
  }
  if (!(recipe.servings > 0) || !recipe.name.trim() || recipe.steps.length === 0
    || recipe.steps.some((step) => !step.text.trim()) || recipe.ingredients.length === 0) {
    reasons.push(reason("incomplete_recipe", "Ingredients, servings, or ordered steps are missing."));
  }
  for (const rule of input.profile.custom_rules ?? []) {
    if (!isCustomRule(rule)) {
      reasons.push(reason("invalid_rule", "A saved food rule could not be checked."));
      continue;
    }
    if (rule.kind === "cuisine" && !recipe.cuisine?.trim()) {
      reasons.push(reason("cuisine_evidence", "This recipe has no cuisine label to check against your exclusion."));
      continue;
    }
    if (rule.kind === "cuisine" && matchesRule(recipe.cuisine ?? "", rule)) {
      reasons.push(reason("custom_cuisine", `${recipe.cuisine} cuisine is excluded by your rule.`));
    }
  }
  const avoidRefs = new Set([...(input.profile.avoid_food_ref_ids ?? []),
    ...(input.explicitAvoidFoodRefIds ?? [])]);
  const avoidDbIds = new Set(input.explicitAvoidFoodDbIds ?? []);
  const avoidNames = new Set((input.explicitAvoidNames ?? []).map(baseFoodName).filter(Boolean));
  const active = input.profile.avoid_allergens.length > 0
    || input.profile.banned_categories.length > 0
    || (input.profile.custom_rules?.length ?? 0) > 0
    || (input.profile.conditions?.length ?? 0) > 0
    || (input.profile.profileRules?.items?.length ?? 0) > 0
    || (input.preferenceFlags?.length ?? 0) > 0;
  for (const ingredient of recipe.ingredients) {
    if (!(ingredient.quantity > 0) || !ingredient.unit.trim()
      || ingredient.grams === null || !(ingredient.grams > 0)) {
      reasons.push(reason("incomplete_ingredient", `Check the quantity for ${ingredient.name}.`, ingredient.seq));
    }
    if (!hasCanonicalIngredientIdentity(ingredient)) {
      reasons.push(reason("unknown_identity", `Identify ${ingredient.name} before recommending this recipe.`, ingredient.seq));
      continue;
    }
    const supplied = input.evidenceBySeq?.[ingredient.seq] ?? {};
    const names = [ingredient.name, ingredient.foodDbId ? dbFood(ingredient.foodDbId)?.name : null]
      .filter((name): name is string => Boolean(name)).map(baseFoodName);
    if ((ingredient.foodRefId !== null && avoidRefs.has(ingredient.foodRefId))
      || (ingredient.foodDbId != null && avoidDbIds.has(ingredient.foodDbId))
      || names.some((name) => name && avoidNames.has(name))) {
      reasons.push(reason("avoid_list", `${ingredient.name} is on your Avoid list.`, ingredient.seq));
      continue;
    }
    if (input.profile.banned_categories.length > 0 && supplied.category == null) {
      reasons.push(reason("category_evidence", `Cannot check your category rules for ${ingredient.name}.`, ingredient.seq));
    }
    if (input.preferenceFlags?.length && supplied.facets === undefined) {
      reasons.push(reason("facet_evidence", `Cannot check your food preferences for ${ingredient.name}.`, ingredient.seq));
    }
    const allergenEvidence = Object.fromEntries(Object.entries(ingredient.allergenEvidence)
      .map(([key, state]) => [key, {
        // The recipe's bare "absent" bit does not prove a complete product label.
        // A loaded, revision-specific PolicyEvidence may supply that stronger proof.
        level: state === "present" ? "listed" : "no_evidence",
        labelComplete: false,
      }] as const));
    const present = Object.entries(ingredient.allergenEvidence)
      .filter(([, state]) => state === "present").map(([key]) => key);
    const mergedEvidence = { ...allergenEvidence, ...supplied.allergenEvidence };
    for (const key of present) mergedEvidence[key] = { level: "listed", labelComplete: false };
    const verdict = evaluatePolicy(input.profile, {
      ...supplied,
      wholeFoodName: wholeFoodNameFor(ingredient, supplied.foodName),
      foodRefId: ingredient.foodRefId,
      allergenTags: [...new Set([...(supplied.allergenTags ?? []), ...present])],
      allergenEvidence: mergedEvidence,
      category: supplied.category ?? null,
      foodName: [ingredient.name, supplied.foodName].filter(Boolean).join(" "),
      onEatsList: false,
      onAvoidList: false,
      preferenceFlags: input.preferenceFlags,
      profileRules: input.profile.profileRules,
    });
    if (verdict.verdict === "blocked") {
      reasons.push(reason("policy_block", `${ingredient.name} ${reasonFragment(verdict.reason)}`, ingredient.seq));
    } else if (verdict.verdict === "unverified" && active) {
      const customUnknown = verdict.marks?.some((mark) => mark.source === "profile"
        && mark.facet.startsWith("custom_ingredient:") && mark.outcome === "unknown");
      if (customUnknown) {
        reasons.push(reason("ingredient_evidence",
          `Cannot check every ingredient in ${ingredient.name} against your custom rule.`, ingredient.seq));
        continue;
      }
      const relevant = verdict.allergens?.filter((finding) => finding.outcome === "unknown")
        .map((finding) => finding.allergen).join(", ");
      reasons.push(reason("policy_unknown", `Cannot check ${relevant || "your restrictions"} for ${ingredient.name}.`, ingredient.seq));
    }
  }
  const status = reasons.some((entry) => ["not_published", "rights", "incomplete_recipe",
    "incomplete_ingredient", "avoid_list", "policy_block", "custom_cuisine"].includes(entry.code))
    ? "blocked" : reasons.length > 0 ? "unknown" : "eligible";
  return { status, reasons };
}

export function withRecipeEligibility(recipe: CatalogRecipe, input: RecipeEligibilityInput): RecipeCandidate {
  return { ...recipe, eligibility: recipeEligibility(recipe, input) };
}
