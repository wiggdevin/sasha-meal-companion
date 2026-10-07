import type { FacetOutcome } from "@/lib/policy/facet-rules";
import type { SuggestionFoodEvidence } from "@/lib/coach/suggest-evidence-types";
import { RUBRIC_VERSION, type Facet } from "@/lib/foods/facet-vocabulary";
import type { Starter } from "@/lib/foods/starter";

/** Add facts proved by an exact bundled-starter row; conflicting cache facts can only deny. */
export function starterSuggestionEvidence(
  starter: Starter, current: SuggestionFoodEvidence,
): SuggestionFoodEvidence {
  const hasAllergen = (key: string) => starter.allergens?.includes(key) === true;
  const hasCategory = (key: string) => starter.categories?.includes(key) === true;
  const derived: Partial<Record<Facet, boolean>> = {
    human_food: true,
    animal_product: !starter.diets.includes("vegan"),
    meat: !starter.diets.includes("pescatarian"),
    fish_seafood: starter.diets.includes("pescatarian")
      && !starter.diets.includes("vegetarian"),
    shellfish: hasAllergen("shellfish"),
    pork: hasCategory("pork"), beef: hasCategory("beef"),
    contains_dairy: hasAllergen("dairy"), contains_egg: hasAllergen("egg"),
    contains_soy: hasAllergen("soy"), contains_peanut: hasAllergen("peanut"),
    contains_tree_nut: hasAllergen("tree-nut"),
    contains_gluten: hasAllergen("gluten"),
    beans: hasCategory("beans"),
  };
  const judgedAt = new Date().toISOString();
  const facets = { ...current.facets };
  for (const [facet, present] of Object.entries(derived) as [Facet, boolean][]) {
    const attested = { p: present ? 1 : 0, rubricVersion: RUBRIC_VERSION, judgedAt };
    // A stale negative may never clear a curated prohibition. A conflicting positive
    // still blocks, and a cached human_food negative still withholds the food.
    if (present && facet !== "human_food") facets[facet] = attested;
    else facets[facet] ??= attested;
  }
  const attestedFacets = Object.fromEntries((Object.entries(derived) as [Facet, boolean][])
    .filter(([facet]) => facet !== "human_food")
    .map(([facet, present]) => [facet, present ? "present" : "absent"] as const));
  return {
    ...current, facets, attestedFacets,
    // Curated positives block; an empty legacy tag list still cannot clear an active allergy.
    allergenTags: [...(starter.allergens ?? [])],
    policyCategories: [...(starter.categories ?? [])],
  };
}


/** Evidence applies only to the reviewed STARTERS catalog, never arbitrary names or labels.
 * Diet tags describe the complete starter, so they also clear matching saved profile rules.
 * Unreviewed facets (especially medical ones) still require the normal policy evidence. */
export function starterFacetOutcome(item: Starter, facet: string): FacetOutcome | null {
  const categories = item.categories ?? [];
  if (facet === "meat") return item.diets.length === 1 && item.diets[0] === "omnivore"
    ? "present" : "absent";
  if (facet === "fish_seafood") return categories.includes("fish") ? "present" : "absent";
  if (facet === "animal_product") return item.diets.includes("vegan") ? "absent" : "present";
  if (facet === "gelatin" && item.diets.includes("vegetarian")) return "absent";
  if ((facet === "honey" || facet === "insect_derived") && item.diets.includes("vegan")) return "absent";
  if (facet === "pork" || facet === "contains_ingredient:pork") {
    return categories.includes("pork") ? "present" : "absent";
  }
  if (facet === "beef" || facet === "contains_ingredient:beef") {
    return categories.includes("beef") ? "present" : "absent";
  }
  return null;
}
