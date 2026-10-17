/**
 * Phase 13 §4, §9 R5: resolves a confirmed profile "never" rule's facet to a `FacetOutcome`,
 * from whichever deterministic evidence source knows it — lib/policy/diet-evidence.ts for a frozen
 * facet, the deterministic `NEW_FACETS`, or an account-named allergen template. Feeds
 * lib/policy/constraints.ts's `evaluatePolicy` (source "profile"); ranking reads the same outcome
 * through lib/policy/profiles/rank-context.ts. Pure: no I/O, no wall-clock read — the caller passes
 * the `asOf` instant, and every item is re-checked here with `isActiveHardRule` (sol BLOCK, p13-s3
 * fix round): an unconfirmed, declined, expired, out-of-window, soft or basis-less item never makes
 * a mark.
 *
 * Phase 18 W2c (docs/specs/phase-18-open-world-foods.md D4, D9): no Jev facet decides a profile
 * rule. A food only Jev flagged is `unknown` (never allowed), and a Jev `absent` no longer clears.
 */
import { allergenKey, textNames } from "@/lib/policy/allergens";
import { FACETS, NEW_FACETS, type Facet, type NewFacet }
  from "@/lib/foods/facet-vocabulary";
import type { FacetOutcome } from "@/lib/policy/facet-rules";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { dietFacetOutcome, type DietEvidence } from "@/lib/policy/diet-evidence";
import { evaluateNewFacet } from "@/lib/policy/profiles/new-facets";
import { isActiveHardRule, type RuleItem } from "@/lib/policy/profiles/types";

const FACET_SET = new Set<string>(FACETS);
const NEW_FACET_SET = new Set<string>(NEW_FACETS);
const ALLERGEN_TEMPLATE_PREFIX = "contains_allergen:";
const FOOD_NAMED_PREFIX = "food_named:";
const INGREDIENT_TEMPLATE_PREFIX = "contains_ingredient:";

/** The food's own deterministic evidence (W2c: the same inputs a preference flag reads). */
export type ProfileFacetEvidence = DietEvidence & {
  ingredientsText?: string | null;
  /**
   * The food's own name/description: a keyword facet reads it with the ingredient text. Phase 13
   * slice 7 (§6 row 5): `food_named:<name>` reads it too — a like/dislike names the food itself,
   * which usually is not part of an ingredient list at all ("salmon" has no ingredient label).
   */
  foodName?: string | null;
  /** Per-serving nutrients: high_sodium, added_sugar and protein_dense read only these. */
  nutrientsPerServing?: Readonly<Partial<Record<NutrientCode, number>>>;
};

const escapeWordPattern = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word match only: "salmon" matches "grilled salmon fillet", never "salmonella". */
function namesFood(name: string, text: string | null | undefined): boolean {
  const key = name.trim().toLowerCase();
  if (key === "" || !text) return false;
  return new RegExp(`(^|[^a-z])${escapeWordPattern(key)}([^a-z]|$)`).test(text.toLowerCase());
}

/**
 * W105: the ingredient names a `contains_ingredient:<description>` rule states. The description is
 * the map's prose ("legume (beans, lentils, chickpeas, peas)", "wine, beer, spirits, liqueur or
 * cooking wine (including cooked-off)", "dairy other than ghee/clarified butter"): the head and each
 * listed name are separate terms, split at commas, slashes, "or" and "and". An exception clause
 * ("other than …", "except …", "including …") names no term, and a leading "any"/"added" is dropped.
 */
export function ingredientTerms(description: string): string[] {
  const text = description.toLowerCase()
    .replace(/\(\s*(?:including|incl\.?|e\.g\.?|such as)\b[^)]*\)/g, " ")
    .replace(/\b(?:other than|except(?: for)?|excluding|but not)\b[^(),]*/g, " ")
    .replace(/[()]/g, ",");
  const terms = text.split(/,|\/|;|\bor\b|\band\b/)
    .map((term) => term.replace(/^\s*(?:(?:any|all|added|other)\s+)+/, "").trim())
    .filter((term) => term.length > 1 && /[a-z]/.test(term));
  return [...new Set(terms)];
}

/** A term, or its plural/singular twin, as a whole word ("legume" matches "legumes"). */
function namesIngredient(term: string, text: string): boolean {
  const forms = new Set([term, `${term}s`, `${term}es`, term.replace(/(?:es|s)$/, "")]);
  return [...forms].some((form) => form.length > 1 && namesFood(form, text));
}

/**
 * Never returns "absent" for a template or NEW_FACETS id from text alone (mirrors R1: a keyword
 * miss is not proof of absence). A frozen `Facet` reads lib/policy/diet-evidence.ts, whose only
 * absences are deterministic: the whole-food class, a reviewed starter outcome, a complete label
 * for alcohol only, or an allergen finding.
 */
export function profileFacetOutcome(facet: string, evidence: ProfileFacetEvidence): FacetOutcome {
  if (FACET_SET.has(facet)) return dietFacetOutcome(facet as Facet, evidence);
  if (NEW_FACET_SET.has(facet)) {
    return evaluateNewFacet(facet as NewFacet, {
      text: [evidence.foodName, evidence.ingredientsText].filter(Boolean).join(" "),
      nutrientsPerServing: evidence.nutrientsPerServing,
    });
  }
  if (facet.startsWith(ALLERGEN_TEMPLATE_PREFIX)) {
    const name = allergenKey(facet.slice(ALLERGEN_TEMPLATE_PREFIX.length));
    return textNames(name, evidence.ingredientsText) ? "present" : "unknown";
  }
  if (facet.startsWith(FOOD_NAMED_PREFIX)) {
    const name = facet.slice(FOOD_NAMED_PREFIX.length);
    const text = [evidence.foodName, evidence.ingredientsText].filter(Boolean).join(" ");
    return namesFood(name, text) ? "present" : "unknown";
  }
  if (facet.startsWith(INGREDIENT_TEMPLATE_PREFIX)) {
    // W105: the food's own name or ingredient text naming a term blocks it. A miss is never proof
    // of absence (no ingredient list is exhaustive about a free-text rule), so it stays `unknown`.
    const text = [evidence.foodName, evidence.ingredientsText].filter(Boolean).join(" ");
    const terms = ingredientTerms(facet.slice(INGREDIENT_TEMPLATE_PREFIX.length));
    return terms.some((term) => namesIngredient(term, text)) ? "present" : "unknown";
  }
  return "unknown";
}

/** The account's profile rule items as built (lib/policy/profiles/loader.ts), with the instant
 *  their confirmation, expiry and calendar windows are judged at. */
export type ProfileRuleSet = { items: readonly RuleItem[]; asOf: Date };
export type ProfilePolicyMark = { facet: string; source: "profile"; outcome: FacetOutcome };

/**
 * One mark per active confirmed hard rule whose facet reads "present" or "unknown" — an "absent"
 * outcome contributes no mark, same as a cleared allergen finding contributes none. A profile's
 * allergy/celiac hard basis is expected to flow through `avoid_allergens` and the existing
 * allergens.ts evidence system instead of duplicating it here as a profile mark; this function
 * carries the rest (religious, user_rule, user_confirmed_safety).
 */
export function activeConfirmedHardMarks(
  ruleSet: ProfileRuleSet | undefined,
  evidence: ProfileFacetEvidence,
): ProfilePolicyMark[] {
  const marks: ProfilePolicyMark[] = [];
  for (const rule of ruleSet?.items ?? []) {
    if (!isActiveHardRule(rule, ruleSet!.asOf)) continue;
    const outcome = profileFacetOutcome(rule.facet, evidence);
    if (outcome === "absent") continue;
    marks.push({ facet: rule.facet, source: "profile", outcome });
  }
  return marks;
}
