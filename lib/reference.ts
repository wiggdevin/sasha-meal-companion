/**
 * Reference data for the Foods screen (PRD §6.3). Static, always reachable, works offline.
 *
 * D1 §6.2: the avoid half of this file is now a LABEL AND HELP DICTIONARY, not a rule list. It
 * says what `gluten` is called on screen and what banning `onion_garlic` means; it never says
 * that any account avoids either. Which rules exist is the account's own `constraint_profiles`
 * row and nothing else, so a brand-new account opens Foods > Avoids with no rules at all.
 *
 * Every key here is a key the server already uses: the allergen keys are `avoid_allergens`
 * values and `lib/foods/facet-vocabulary.ts` facets; the category keys are
 * `lib/catalog/category-map.ts`'s `POLICY_CATEGORY_KEYS`, which is what
 * `constraint_profiles.banned_categories` is matched against (lib/policy/constraints.ts).
 */

import type { PolicyCategoryKey } from "@/lib/catalog/category-map";

export type RuleLabel = { label: string; help: string };

/**
 * The allergens a rule can name, with a neutral description of each. Offering a key is not
 * avoiding it: nothing is on until the account's row says so.
 */
export const ALLERGEN_LABELS: Record<string, RuleLabel> = {
  gluten: { label: "Gluten", help: "Wheat, barley, rye and anything made from them." },
  dairy: { label: "Dairy", help: "Milk, cheese, yoghurt, butter and milk solids." },
  egg: { label: "Egg", help: "Whole egg, egg white and egg used as a binder." },
  soy: { label: "Soy", help: "Soybeans, soy sauce, tofu, edamame and soy protein." },
  peanut: { label: "Peanut", help: "Peanuts, peanut butter and peanut oil." },
  "tree-nut": { label: "Tree nuts", help: "Almond, cashew, walnut, pecan and the rest." },
  shellfish: { label: "Shellfish", help: "Prawns, crab, lobster, mussels and clams." },
  fish: { label: "Fish", help: "Finned fish, fish sauce and anchovy." },
  sesame: { label: "Sesame", help: "Sesame seeds, tahini and sesame oil." },
  // Label only, never offered (ruling 2026-09-22): `apple` is not a rule anyone can add. The
  // label stays so a row that still carries the key — a phone that loaded before
  // 20261027090000_drop_apple_allergen.sql ran — renders "Apple" with a Remove, not a raw key.
  apple: { label: "Apple", help: "Apple, applesauce and apple in processed fruit purées." },
};

/** The allergen keys the picker never offers, even though a label exists for them. */
const RETIRED_ALLERGEN_KEYS = new Set(["apple"]);

/** Every allergen key a rule can be added for, in the order the picker offers them. */
export const ALLERGEN_KEYS = Object.keys(ALLERGEN_LABELS)
  .filter((key) => !RETIRED_ALLERGEN_KEYS.has(key));

/**
 * The banned-category keys, with what each one covers. Same rule: a key is an option, never a
 * claim about anybody's diet.
 */
export const CATEGORY_LABELS: Record<PolicyCategoryKey, RuleLabel> = {
  raw_cruciferous: {
    label: "Raw cruciferous vegetables",
    help: "Raw broccoli, cauliflower, cabbage, kale and Brussels sprouts.",
  },
  raw_leafy_greens: {
    label: "Raw leafy greens",
    help: "Uncooked salad greens, spinach and rocket.",
  },
  onion_garlic: { label: "Onion and garlic", help: "Onion, garlic, leek and shallot." },
  beans: { label: "Beans and pulses", help: "Beans, lentils, chickpeas and split peas." },
  simple_sugars: {
    label: "Simple sugars",
    help: "Honey, syrups, table sugar, agave and jam.",
  },
};

/** Every category key a rule can be added for, in the order the picker offers them. */
export const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS) as PolicyCategoryKey[];

/** The on-screen name for a key, falling back to the key itself for one this build predates. */
export function ruleLabel(key: string): string {
  return ALLERGEN_LABELS[key]?.label ?? CATEGORY_LABELS[key as PolicyCategoryKey]?.label ?? key;
}

/** The help line for a key, or an empty string when there is nothing generic to say. */
export function ruleHelp(key: string): string {
  return ALLERGEN_LABELS[key]?.help ?? CATEGORY_LABELS[key as PolicyCategoryKey]?.help ?? "";
}
