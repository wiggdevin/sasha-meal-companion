/**
 * The food NAME as the allergen keyword scan reads it (lib/policy/allergens.ts deriveEvidence).
 * Kept apart from allergens.ts, which is at its size cap (tests/speed/file-size.test.ts).
 */

/**
 * W022 (B197): USDA SR descriptions open with a food-group head, and coconut's is "Nuts,"
 * ("Nuts, coconut milk, canned"). That head names the survey's group, not an ingredient, and
 * "coconut" itself is excluded from tree nut (lib/policy/allergens.ts), so a food NAME in the SR
 * shape is read without the head. The shape is narrow on purpose: the head must be followed by SR's
 * coconut products (meat, milk, cream, water), so a branded or custom name such as
 * "Nuts, coconut, raisins" keeps its "nuts" listing. Names only: ingredient text keeps every
 * "nuts" it says, and the rest of the name is still scanned. A coconut food left with no other
 * evidence reads `unknown` for tree nut ("Check the label"), never `allowed`.
 */
const USDA_COCONUT_HEAD = /^\s*nuts,\s*(?=coconut (?:meat|milk|cream|water)\b)/i;

export function nameForScan(name: string | null | undefined): string | null | undefined {
  return typeof name === "string" ? name.replace(USDA_COCONUT_HEAD, "") : name;
}
