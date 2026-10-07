/**
 * The order suggestion cards try their anchors in, for one meal type (2026-10-03, owner report).
 * The account's protein marks came alphabetically, and lean scallops won every macro race, so
 * every card was "Scallops, sea" or "Scallops, bay". Now the anchors that suit the meal come first
 * (eggs or Greek yogurt at breakfast, chicken or salmon at dinner), one per family before any
 * family repeats, and a family that never suits the meal (scallops or steak at 7:30 am) is left
 * out unless the person's own words ask for it — or nothing else on their list is a protein. A
 * family the words refuse ("no eggs") is left out whatever the meal.
 *
 * Pure. No I/O.
 */

import { anchorSuitability, familyKey } from "@/lib/coach/meal-pairings";
import type { MealType } from "@/lib/coach/meal-type";
import { refusedBy, splitWish } from "@/lib/coach/wish-negation";

export function orderAnchors(
  anchors: readonly string[], type: MealType, wish: string | null | undefined, untimed = false,
): string[] {
  // A protein the wish refuses ("without chicken") anchors no card at all.
  const refused = splitWish(wish).negated;
  const rated = anchors.filter((name) => !refusedBy(name, refused)).map((name, index) => ({
    name, index, suit: anchorSuitability(name, type, wish, untimed), family: familyKey(name),
  }));
  const kept = rated.some((row) => row.suit > 0) ? rated.filter((row) => row.suit > 0) : rated;
  const sorted = [...kept].sort((a, b) => b.suit - a.suit || a.index - b.index);
  const firsts: typeof sorted = [];
  const repeats: typeof sorted = [];
  const seen = new Set<string>();
  for (const row of sorted) {
    (seen.has(row.family) ? repeats : firsts).push(row);
    seen.add(row.family);
  }
  return [...firsts, ...repeats].map((row) => row.name);
}

/** The position of each anchor's family among the distinct families, for side rotation. */
export function familyRotation(ordered: readonly string[]): Map<string, number> {
  const rank = new Map<string, number>();
  for (const name of ordered) {
    const family = familyKey(name);
    if (!rank.has(family)) rank.set(family, rank.size);
  }
  return rank;
}
