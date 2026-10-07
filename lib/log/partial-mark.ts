/** The partial-nutrition mark a log row earns (#21). Pure. */
/**
 * Whether a server row logs a partly measured recipe (#21). Each item's RECORDED flag decides
 * (`nutrition_partial`, written server-side since 20261210090400): any true marks the entry. Items
 * with no recorded flag — not a recipe, or written before that migration — fall back to the
 * recipes already on this phone (approximate: the recipe's current revision). Answers null only
 * when an unrecorded item exists and those recipes could not be read: the card keeps its mark.
 */
export function rowNutritionPartial(
  row: Record<string, unknown>, partialRefs: ReadonlySet<string> | null,
): boolean | null {
  const items = Array.isArray(row.items)
    ? row.items as { food_ref_id?: unknown; nutrition_partial?: unknown }[] : [];
  if (items.some((item) => item.nutrition_partial === true)) return true;
  const unrecorded = items.filter((item) => typeof item.nutrition_partial !== "boolean");
  if (unrecorded.length === 0) return false;
  if (partialRefs === null) return null;
  return unrecorded.some((item) => typeof item.food_ref_id === "string" && partialRefs.has(item.food_ref_id));
}
