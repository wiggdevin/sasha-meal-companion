/**
 * The name an Eats/Avoid mark applies to — readiness pass 2026-09-18.
 *
 * "Add watermelon to my avoid list" used to write ONE `food_ref` id. The catalog holds six
 * watermelon rows, so the next grounding ranked a different, unmarked row first and handed it back
 * unflagged. A mark is about the FOOD, not about the row that happened to win one search.
 *
 * The base name is the first comma segment: USDA descriptions put the food first and every
 * qualifier after a comma, so "Watermelon, raw" and "Watermelon, seedless, raw" are one food and
 * "Watermelon juice" is another. Accents are folded and case dropped the same way
 * `lib/search/query.ts` folds them, so a mark and a search can never disagree about what one food
 * is called.
 *
 * Pure. No I/O — the client half and the server half both read it.
 */

/** At most this many rows carry one mark: a base name with more than this is a word, not a food. */
export const SAME_NAME_CAP = 25;

export function baseFoodName(name: string): string {
  return (name ?? "").split(",")[0]
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Two names for one food. An empty base name matches nothing, not everything. */
export function sameBaseName(a: string, b: string): boolean {
  const base = baseFoodName(a);
  return base.length > 0 && base === baseFoodName(b);
}
