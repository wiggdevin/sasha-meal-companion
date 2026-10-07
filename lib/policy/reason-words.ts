/**
 * The one place a policy reason code (`evaluatePolicy`'s `allergen:peanut`, `facet:meat`,
 * `category:x`, `avoid_list`, `rule:x`) becomes words. Pure and dependency-free so the server
 * (recipe eligibility, shopping marks) and the phone (coach cards, barcode badge) say the same.
 *
 * Phase 18 W2c: diet and religious rules block with `facet:*` codes (vegetarian → facet:meat,
 * no_pork → facet:pork …) and profile hard rules with `rule:<facet>`. Neither is ever shown raw.
 */

/** A food's facet in words, as the predicate after its name. "Contains" holds for a whole food, a dish
 *  and a derivative alike ("Gelatin contains meat", W2c maps gelatin to facet:meat). */
const FACET_PREDICATE: Record<string, string> = {
  meat: "contains meat",
  pork: "contains pork",
  beef: "contains beef",
  fish_seafood: "contains fish or seafood",
  animal_product: "contains animal products",
  alcohol: "contains alcohol",
  contains_dairy: "contains dairy",
};

/** The same facets as a short tag. */
const FACET_LABEL: Record<string, string> = {
  meat: "Meat",
  pork: "Contains pork",
  beef: "Contains beef",
  fish_seafood: "Fish or seafood",
  animal_product: "Animal product",
  alcohol: "Contains alcohol",
  contains_dairy: "Contains dairy",
};

const CUSTOM = "rule:custom_ingredient:";

/** A diet or religious facet as the predicate after a food's name ("contains pork"), or null. */
export function facetPredicate(facet: string): string | null {
  return FACET_PREDICATE[facet] ?? null;
}

function words(code: string): string {
  return code.replace(/_/g, " ");
}

/** `facet:pork` and `rule:pork` name the same thing; anything else is not a facet. */
function facetKey(code: string): string | null {
  if (code.startsWith("facet:")) return code.slice("facet:".length);
  if (code.startsWith("rule:") && !code.startsWith(CUSTOM)) return code.slice("rule:".length);
  return null;
}

/**
 * The fragment that follows a food's name: "has peanut, which your rules exclude.",
 * "contains meat, which your rules exclude." A code it does not know reads as a plain rule miss.
 */
export function reasonFragment(reason: string | null | undefined): string {
  const code = reason ?? "";
  if (code.startsWith("allergen:")) return `has ${words(code.slice(9))}, which your rules exclude.`;
  if (code === "avoid_list") return "is on your Avoid list.";
  if (code.startsWith("category:")) return `is in a category your rules exclude (${words(code.slice(9))}).`;
  if (code.startsWith(CUSTOM)) return `matches your rule against ${code.slice(CUSTOM.length)}.`;
  const facet = facetKey(code);
  if (facet !== null) {
    const predicate = FACET_PREDICATE[facet];
    return predicate ? `${predicate}, which your rules exclude.` : "does not fit your food rules.";
  }
  return "is excluded by your food rules.";
}

/** A short tag for a blocked item ("Contains peanut", "Meat"); `fallback` for an unknown code. */
export function reasonLabel(reason: string | null | undefined, fallback = "Off your rules"): string {
  const code = reason ?? "";
  if (code.startsWith("allergen:")) return `Contains ${words(code.slice(9))}`;
  if (code === "avoid_list") return "On your avoid list";
  if (code.startsWith("category:")) return `On your avoid list: ${words(code.slice(9))}`;
  if (code.startsWith(CUSTOM)) return `Your rule: ${code.slice(CUSTOM.length)}`;
  const facet = facetKey(code);
  if (facet !== null) return FACET_LABEL[facet] ?? fallback;
  return fallback;
}
