import type { RecipeCandidate, RecipeIngredient } from "@/lib/recipe-catalog/types";
import { dbFood } from "@/lib/food-db";
import { textNames } from "@/lib/policy/allergens";
import { absentAnimalFacets, classifyWholeFood } from "@/lib/policy/whole-foods";

export type DietFact = "high-protein" | "vegan" | "vegetarian" | "gluten-free" | "dairy-free"
  | "contains-gluten" | "contains-dairy";

/** Protein carrying at least this share of a serving's calories reads as high protein. */
export const HIGH_PROTEIN_SHARE = 0.3;

type Evidence = "present" | "absent" | "unknown" | undefined;

type NamedIngredient = Pick<RecipeIngredient, "name" | "foodDbId" | "foodRefId"
  | "catalogFoodRevisionId" | "catalogFoodName">;

/**
 * Every name an ingredient goes by: its line name, the bundled food it maps to, and the pinned
 * catalog revision's description when the reader loaded it.
 */
function namesOf(ingredient: NamedIngredient): string[] {
  const bundled = ingredient.foodDbId ? dbFood(ingredient.foodDbId)?.name : undefined;
  return [ingredient.name, bundled, ingredient.catalogFoodName]
    .filter((name): name is string => Boolean(name?.trim()));
}

/**
 * True when the line points at a food whose name this code did not see: a pinned catalog revision
 * or food ref with no loaded description, or a bundled id that resolves to nothing. Neither its
 * names nor its authored evidence describe that food, so such a line blocks every diet and
 * free-from badge.
 */
function hasUnseenIdentity(ingredient: NamedIngredient): boolean {
  if (ingredient.foodDbId && !dbFood(ingredient.foodDbId)) return true;
  const pinned = ingredient.catalogFoodRevisionId != null || ingredient.foodRefId != null;
  return pinned && !ingredient.catalogFoodName?.trim();
}

/**
 * "free": every ingredient's evidence says absent AND no name the ingredient goes by names the
 * allergen (the policy's own keyword table, lib/policy/allergens.ts textNames, with its exclusions:
 * "Wheat flour" is never gluten-free, "Almond milk" can be dairy-free). "contains": any evidence
 * says present. A line pinned to a food whose name was not loaded blocks the free claim outright.
 * Otherwise unknown, and nothing is claimed: a missing record is never read as safe.
 */
function allergenFact(recipe: Pick<RecipeCandidate, "ingredients">, key: string): "free" | "contains" | null {
  const evidence: Evidence[] = recipe.ingredients.map((ingredient) => ingredient.allergenEvidence?.[key]);
  if (evidence.some((value) => value === "present")) return "contains";
  if (recipe.ingredients.some((ingredient) => namesOf(ingredient).some((name) => textNames(key, name)))) {
    return null;
  }
  // A line pinned to a food whose name was not loaded: its authored evidence describes the line,
  // not the pinned food, so no free-from claim (review round 7).
  if (recipe.ingredients.some(hasUnseenIdentity)) return null;
  if (evidence.length > 0 && evidence.every((value) => value === "absent")) return "free";
  return null;
}

/** Meat and other animal-flesh words the allergen table has no rule for (it covers fish/shellfish). */
const MEAT_WORDS = /\b(?:beef|pork|ham|bacon|prosciutto|salami|pepperoni|sausages?|chicken|turkey|duck|goose|lamb|mutton|veal|venison|bison|goat|meat|meatballs?|lard|tallow|suet|gelatin|gelatine|chorizo|pancetta|bone broth)\b/;
/** Animal products a vegan claim rules out, beyond dairy and egg. */
const VEGAN_WORDS = /\b(?:honey|beeswax|carmine|isinglass)\b/;

/** True when a name names something the claim rules out — whatever the classifier makes of it. */
function nameRefutes(name: string, claim: DietClaim): boolean {
  const lower = name.toLowerCase();
  // "Goat cheese" names the milk, not the meat.
  const flesh = MEAT_WORDS.test(textNames("dairy", lower) ? lower.replace(/\bgoat(?:'s)?\b/g, " ") : lower);
  if (flesh || textNames("fish", lower) || textNames("shellfish", lower)) return true;
  return claim === "vegan" && (textNames("dairy", lower) || textNames("egg", lower) || VEGAN_WORDS.test(lower));
}

/** The animal facets each diet claim needs every ingredient to rule out (lib/policy/facet-rules.ts). */
const DIET_FACETS = {
  vegetarian: ["meat", "fish_seafood", "shellfish"],
  vegan: ["meat", "fish_seafood", "shellfish", "animal_product"],
} as const;

type DietClaim = keyof typeof DIET_FACETS;

/**
 * Whether one ingredient's own identity supports a diet claim (calculation audit F6). Every name
 * the ingredient has is judged — its line name and, when it maps to one, the bundled food's name —
 * and any refutation wins, whichever name carries it:
 *   - stored facet evidence "present" refutes;
 *   - a name that names an excluded food (meat, fish, shellfish words; dairy, egg, honey for
 *     vegan) refutes, even when stored evidence says "absent" or the classifier cannot judge it;
 *   - a name that classifies as a plain whole food whose class does not rule every facet out
 *     (meat, fish; dairy or egg for vegan) refutes;
 *   - a bundled id that resolves to no food, or a pinned catalog food whose description was not
 *     loaded, is an identity this code cannot check, so it refutes.
 * With nothing refuting, it is supported when EVERY name classifies as a class that rules every
 * facet out, or when every facet's stored evidence is "absent". Otherwise it is unproven, and an
 * unproven ingredient means no badge.
 */
function ingredientSupports(ingredient: NamedIngredient & Pick<RecipeIngredient, "allergenEvidence">,
  claim: DietClaim): boolean {
  const facets = DIET_FACETS[claim];
  const evidence = facets.map((facet) => ingredient.allergenEvidence?.[facet]);
  if (evidence.some((value) => value === "present")) return false;
  // A pinned food whose name was not loaded (or a bundled id that resolves to nothing): the line's
  // own name and evidence describe the authored line, not the pinned food — no badge (round 7).
  if (hasUnseenIdentity(ingredient)) return false;
  // Names decide first: any name that names an excluded food ("Beef stock", "Milk") refutes, and
  // so does a name that classifies to a refuting class. Then every name must classify as a class
  // that rules the facets out; a name that does not classify (a prepared food) leaves the identity
  // unproven, and only complete stored evidence — with no name refuting — can then support it.
  const names = namesOf(ingredient);
  if (names.some((name) => nameRefutes(name, claim))) return false;
  let everyNameSupports = names.length > 0;
  for (const name of names) {
    const match = classifyWholeFood({ foodName: name });
    if (!match) { everyNameSupports = false; continue; }
    const ruledOut = new Set(absentAnimalFacets(match));
    if (!facets.every((facet) => ruledOut.has(facet))) return false;
  }
  return everyNameSupports || evidence.every((value) => value === "absent");
}

/** Vegan or vegetarian only when the authored tag AND every ingredient's identity agree. */
function dietClaim(recipe: Pick<RecipeCandidate, "ingredients" | "dishTags">): DietClaim | null {
  const tags = new Set(recipe.dishTags.map((tag) => tag.toLowerCase()));
  if (recipe.ingredients.length === 0) return null;
  const supported = (claim: DietClaim) => recipe.ingredients.every((item) => ingredientSupports(item, claim));
  if (tags.has("vegan") && supported("vegan")) return "vegan";
  if ((tags.has("vegan") || tags.has("vegetarian")) && supported("vegetarian")) return "vegetarian";
  return null;
}

/**
 * What a recipe can honestly be badged with (owner, 2026-10-04: quick-read icons for high protein,
 * gluten-free, dairy, vegan, vegetarian). High protein comes from its own macros; vegan and vegetarian
 * from the catalog's authored dish tags confirmed by every ingredient's identity (a "vegan" tag on a
 * recipe with beef earns no badge, audit F6); gluten and dairy only from ingredient evidence that no
 * ingredient name contradicts, so a recipe with no evidence carries no free-from claim.
 */
export function recipeDietFacts(recipe: Pick<RecipeCandidate, "ingredients" | "dishTags" | "nutritionPerServing">): DietFact[] {
  const facts: DietFact[] = [];
  const kcal = recipe.nutritionPerServing.kcal?.value ?? null;
  const protein = recipe.nutritionPerServing.protein?.value ?? null;
  if (kcal && protein !== null && (protein * 4) / kcal >= HIGH_PROTEIN_SHARE) facts.push("high-protein");
  const diet = dietClaim(recipe);
  if (diet) facts.push(diet);
  const gluten = allergenFact(recipe, "gluten");
  const dairy = allergenFact(recipe, "dairy");
  if (gluten) facts.push(gluten === "free" ? "gluten-free" : "contains-gluten");
  if (dairy) facts.push(dairy === "free" ? "dairy-free" : "contains-dairy");
  return facts;
}
