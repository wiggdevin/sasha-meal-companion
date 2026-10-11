/**
 * The card Today shows the moment the user confirms one catalog food — a scan, or a search pick.
 *
 * T0 §3 says every commit is local-first, and §6 budgets the card at 100 ms from the tap. The scan
 * sheet passed no optimistic card at all, so a barcode save showed nothing until the POST answered
 * — up to the whole ten-second commit budget on a bad connection (Grok pass 11, MEDIUM 4).
 *
 * The numbers are the ones the portion view is already showing them, computed from the cached
 * revision, and the item carries the same id the request sends, so the reply reconciles it.
 */
import type { CachedPortion, CachedRevision } from "@/lib/db/catalog-cache";
import { liveStrip, snapshotFor } from "@/lib/log-client";
import type { LoggedFood, LoggedItem } from "@/lib/types";

/** Portion counts as the user reads them: whole where they are whole, two decimals where they are not. */
export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * What a barcode commit stores for its one item (audit 2026-10-10 A035). With no portion picked the
 * amount is grams, so `qty` is the grams in unit "g" — the same reading the card above and the Log
 * sheet use. The "How many" count multiplies a portion only; sent with "g" it stored 3 g for 300 g.
 */
export function scanItemAmount(edits: { grams: number; qty: number; portionId: number | null }) {
  return edits.portionId === null
    ? { grams: edits.grams, qty: edits.grams, unit: "g", portionId: null }
    : { grams: edits.grams, qty: edits.qty, unit: "portion", portionId: edits.portionId };
}

export function catalogCard(input: {
  revision: CachedRevision;
  entryId: string;
  itemId: string;
  foodRefId: string;
  grams: number;
  qty: number;
  portion: Pick<CachedPortion, "description"> | null;
  at: Date;
  flags?: string[];
}): LoggedFood {
  const { revision, entryId, itemId, foodRefId, grams, qty, portion, at } = input;
  const strip = liveStrip(revision, grams);
  const macros = { kcal: strip.kcal, protein: strip.protein, carbs: strip.carbs, fat: strip.fat };
  const portionLabel = portion ? `${fmt(qty)} × ${portion.description}` : `${fmt(grams)} g`;
  const item: LoggedItem = {
    id: itemId, seq: 1, food_ref_id: foodRefId, grams,
    qty: portion ? qty : grams, unit: portion ? "portion" : "g",
    snapshot: snapshotFor(revision, grams),
    foodId: `catalog:${revision.catalog_food_id}`,
    name: revision.description, portionLabel, macros,
  };
  return {
    id: entryId, foodId: item.foodId, name: revision.description, portionLabel,
    qty: item.qty, grams, macros,
    ...(input.flags?.length ? { flags: input.flags } : {}),
    items: [item], at: at.toISOString(),
  };
}
