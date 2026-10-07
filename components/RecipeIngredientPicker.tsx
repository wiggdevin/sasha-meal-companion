"use client";

import CatalogSearch from "@/components/CatalogSearch";
import RecipeFoodSearch from "@/components/RecipeFoodSearch";
import type { CatalogRow } from "@/lib/catalog-client";

/**
 * The ingredient picker, both tiers. Their own list comes back from either one with a null
 * `catalogFoodId` — a plain lib/store.ts Food has no user_foods row to point a recipe item at — so
 * `mine` stays empty instead of offering a row that could not be added. With the catalog off the
 * bundled list is the ingredient source; a pick from either tier runs the same transition in
 * lib/recipes/recipe-sheet-state.ts, and a refusal shows its line here, never a silent no-op.
 */
export default function RecipeIngredientPicker({ useCatalog, query, notice, onQuery,
  onPickBundled, onPickCatalog }: {
  useCatalog: boolean; query: string; notice: string | null; onQuery: (query: string) => void;
  onPickBundled: (bundledId: string) => void; onPickCatalog: (row: CatalogRow) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {useCatalog ? (
        <CatalogSearch mine={{}} onPick={onPickCatalog} />
      ) : (
        <RecipeFoodSearch query={query} mine={{}} onQuery={onQuery}
          onPick={(hit) => onPickBundled(hit.id)} />
      )}
      {notice && (
        <p className="px-1.5 py-2 text-tiny text-alert" role="status">{notice}</p>
      )}
    </div>
  );
}
