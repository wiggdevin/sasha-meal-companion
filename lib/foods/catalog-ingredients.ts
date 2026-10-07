import { looksLikeCompleteList } from "@/lib/policy/allergens";
import type { FacetFoodIdentity } from "@/lib/foods/facet-keys";

export type FacetWarmFood = {
  identity: FacetFoodIdentity;
  name: string;
  brand?: string | null;
  ingredientsText?: string | null;
  /** Stored as the canonical hash's description field. */
  category?: string | null;
  /** Stored as the canonical hash's preparation field. */
  serving?: string | null;
  /** Cache ownership only. This value never enters provider state. */
  ownerUserId?: string | null;
  /**
   * Phase 13 §5: whether `ingredientsText` is a complete printed list the allergen parser can
   * judge. Never provider state; it decides whether silence can mean not_listed.
   */
  labelComplete?: boolean;
  /** Legacy allergen tags on the revision's rows (they may only add `listed`). */
  allergenTags?: string[];
};

export type CatalogIngredientRow = {
  seq: number;
  name: string;
  raw_text?: string | null;
  allergen_tags?: string[] | null;
};

export type CatalogWarmRow = {
  id: number;
  description: string;
  brand: string | null;
  category: string | null;
  prep_state: string | null;
  catalog_ingredients: CatalogIngredientRow[];
  catalog_portions: { seq: number; description: string | null; is_default: boolean }[];
};

/** Complete ingredient evidence: every row in seq order, preferring its verbatim fragment. */
export function catalogIngredientsText(rows: readonly CatalogIngredientRow[]): string | null {
  const parts = [...rows].sort((a, b) => a.seq - b.seq).map((row) => {
    const raw = row.raw_text?.trim();
    return raw || row.name.trim();
  }).filter(Boolean);
  return parts.join(", ") || null;
}

/**
 * The text that decides whether the label reads as a COMPLETE list (sol finding: catalog-
 * ingredients.ts duplication). The real write path (supabase/migrations/20261014090000_
 * barcode_write_category.sql) puts the product's full verbatim ingredient statement in seq 1's
 * own `raw_text`, with every later row carrying only its own split fragment in `name` and no
 * `raw_text`. `catalogIngredientsText` joining seq 1's already-complete text with those same
 * fragments again double-counts it — a genuinely cropped, unterminated two-item list like
 * "Water, sugar" picks up a third comma from its own next token and stops reading as cropped.
 * When the rows match that exact shape, seq 1's raw_text alone is the text to judge; otherwise
 * (each row carries its own distinct fragment, or nothing has a verbatim raw_text at all) the
 * normal per-row join is unaffected.
 *
 * finding #5: exported so lib/server/barcode.ts's own read of the same `catalog_ingredients`
 * shape (toMatch, for a cached barcode match) can judge completeness the same way — it used to
 * join `catalogIngredientsText` over seq >= 1 directly, hitting the exact double-count this
 * function exists to avoid.
 *
 * ORCHESTRATOR RULING (round 7): the strict completeness predicate (lib/policy/label-
 * completeness.ts) requires the caller to say whether its text is the label's own VERBATIM
 * statement, condition (a) — never a join of parsed names. `verbatim` is true only in the one
 * shape the real write path actually produces (seq 1's raw_text alone, nothing else carrying its
 * own); the joined fallback below is still useful for keyword/listed-escalation, but it is never
 * the label's own printed text, so every caller must pass `verbatim: false` for it to
 * `looksLikeCompleteList`/`labelEvidence` — never treat it as complete no matter its shape.
 */
export type CompletenessText = { text: string | null; verbatim: boolean };

export function completenessText(rows: readonly CatalogIngredientRow[]): CompletenessText {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const verbatim = sorted[0]?.seq === 1 ? sorted[0].raw_text?.trim() : undefined;
  const restCarryNoRawText = sorted.slice(1).every((row) => !row.raw_text?.trim());
  return verbatim && restCarryNoRawText
    ? { text: verbatim, verbatim: true }
    : { text: catalogIngredientsText(sorted), verbatim: false };
}

/** One catalog-to-facet mapper shared by the request hook and both offline passes. */
export function catalogWarmFood(row: CatalogWarmRow): FacetWarmFood {
  const portions = [...(row.catalog_portions ?? [])].sort((a, b) =>
    Number(b.is_default) - Number(a.is_default) || a.seq - b.seq);
  const serving = [row.prep_state, portions[0]?.description].filter(Boolean).join("; ") || null;
  const rows = row.catalog_ingredients ?? [];
  // Seq 0 is the provider's declared-allergen line, not the ingredient list (lib/catalog/off-map.ts):
  // it can list an allergen but never makes the list complete.
  const list = completenessText(rows.filter((ingredient) => ingredient.seq >= 1));
  return {
    identity: { kind: "catalog_revision", id: row.id },
    name: row.description,
    brand: row.brand,
    ingredientsText: catalogIngredientsText(rows),
    category: row.category,
    serving,
    labelComplete: looksLikeCompleteList(list.text, { verbatim: list.verbatim }),
    allergenTags: [...new Set(rows.flatMap((ingredient) => ingredient.allergen_tags ?? []))],
  };
}
