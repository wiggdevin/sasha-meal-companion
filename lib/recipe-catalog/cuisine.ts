/**
 * Cuisine families for recipe search. "Italian" must find an "Italian-inspired" recipe, so the
 * label is folded to its family before it is compared: case, accents, dash and space variants,
 * and one trailing "inspired". No synonym is invented — "Tuscan" is not "Italian".
 *
 * Pure. No I/O — the repository, the candidate filter and the route read it alike.
 */

const INSPIRED = /\s+inspired$/;

export function normalizeCuisineFamily(value: string): string {
  const words = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words.replace(INSPIRED, "");
}

/**
 * The SQL `ilike` pattern for a family: contains, with every word in order. Only letters and
 * digits survive normalization, so a caller's `%` or `_` never becomes a wildcard.
 */
export function cuisineSearchPattern(value: string): string {
  const family = normalizeCuisineFamily(value);
  return family ? `%${family.split(" ").join("%")}%` : "%";
}
