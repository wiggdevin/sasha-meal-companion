/**
 * Lookups over the curated pairing table (lib/meals/data/pairings.ts, moved there in Phase 17 O1
 * and re-exported here so suggest_options and its tests read the same rows as before).
 *
 * Deterministic. No I/O.
 */

import { splitWish } from "@/lib/coach/wish-negation";
import type { MealType } from "@/lib/coach/meal-type";
import { PAIRING_FAMILIES, GENERIC_SIDES, type PairingFamily, type Sides } from "@/lib/meals/data/pairings";

export { PAIRING_FAMILIES, GENERIC_SIDES, type PairingFamily, type Sides };

/** The family a food belongs to, or null when the table does not know it. */
export function pairingFamily(name: string): PairingFamily | null {
  const lower = name.toLowerCase();
  return PAIRING_FAMILIES.find((family) => family.match.test(lower)) ?? null;
}

/**
 * The anchor family key cards are told apart by: the word the table's family matched, else the
 * name's first comma segment, singular. "Scallops, sea" and "Scallops, bay" are one family; "Protein 1" and
 * "Protein 2" are two.
 */
export function familyKey(name: string): string {
  const lower = name.toLowerCase();
  const family = pairingFamily(lower);
  // The word the family matched, not the family: chicken and turkey are two choices, though
  // they pair with the same sides; sea and bay scallops are one.
  const matched = family?.match.exec(lower)?.[0].split(/\s+/)[0];
  const head = matched ?? lower.split(",")[0].trim().replace(/\s+/g, " ");
  // Singular, but a word ending "ss" or "us" is already singular: "bass" stays "bass".
  return head.replace(/(?<=[a-z]{3})(?<![su])(?:es|s)$/, "");
}

/** The sides a family pairs with in this template; the generic table when the family has none. */
export function sidesFor(name: string, template: "breakfast" | "main" | "snack"): Sides {
  const family = pairingFamily(name);
  const own = family?.[template]
    ?? (template === "snack" ? family?.breakfast : undefined);
  return own ?? GENERIC_SIDES[template];
}

/**
 * How well a family suits a meal type: 2 usual, 1 neutral, 0 never. A family the person's own
 * words name is always usual — a typed wish overrides the template.
 */
export function anchorSuitability(
  name: string, type: MealType, wish: string | null | undefined, untimed = false,
): 0 | 1 | 2 {
  const family = pairingFamily(name);
  // Only what the wish asks FOR: "no eggs" does not make eggs the usual breakfast.
  const words = splitWish(wish).positive;
  if (family && words && family.match.test(words)) return 2;
  if (!family) return 1;
  // Time unknown (re-audit r2 #3): a family that suits every meal (eggs, chicken) leads, and one
  // some meal refuses (scallops, steak) follows, never "usual" at a meal that may be breakfast.
  if (untimed) return family.never.length === 0 ? 2 : 1;
  if (family.never.includes(type)) return 0;
  if (family.usual.includes(type) || type === "other") return 2;
  return 1;
}

const keywordCache = new Map<string, RegExp>();
/** Whether a pairing word names this food, at a word start ("rice" never matches "licorice"). */
export function namesSide(name: string, word: string): boolean {
  let pattern = keywordCache.get(word);
  if (!pattern) {
    pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    keywordCache.set(word, pattern);
  }
  return pattern.test(name);
}

/** The position of the first pairing word that names this food, or -1. */
export function pairingRank(name: string, words: readonly string[]): number {
  return words.findIndex((word) => namesSide(name, word));
}
