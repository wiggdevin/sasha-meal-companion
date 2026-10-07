import "server-only";

/**
 * The catalog's own default portion, offered as the typical serving for a logged food. The Jev
 * `serving_identity` choice that used to live here had no production caller and was removed on
 * 2026-10-04 (AI-integration audit, dead purpose).
 */
export type CatalogServing = {
  id: string | number;
  description: string;
  gramWeight: number;
  isDefault: boolean;
};

export type TypicalServingSuggestion = {
  portionId: string;
  label: string;
  grams: number;
};

/** Returns the catalog-authored default as a suggestion; it does not apply or convert it. */
export function typicalServingSuggestion(
  portions: readonly CatalogServing[],
): TypicalServingSuggestion | null {
  const portion = portions.find((candidate) =>
    candidate.isDefault && candidate.description.trim().length > 0
      && Number.isFinite(candidate.gramWeight) && candidate.gramWeight > 0);
  return portion ? {
    portionId: String(portion.id),
    label: portion.description,
    grams: portion.gramWeight,
  } : null;
}
