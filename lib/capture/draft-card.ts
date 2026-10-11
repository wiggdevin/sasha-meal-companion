/**
 * The optimistic card a capture commit puts on Today. Moved out of lib/capture-client.ts unchanged
 * (W017), so that file stays under 400 lines.
 */
import type { EditedItem } from "@/lib/capture-client";
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/capture/label-food";
import type { ProposeResponse } from "@/lib/capture/types";
import type { LoggedFood, LoggedItem } from "@/lib/types";

/**
 * The card Today shows the moment the user taps Save on the confirm sheet (T0 §3, Grok 4.6 MEDIUM 6).
 *
 * A draft carries no nutrients — they come from the catalog rows the items were grounded to, and
 * only the server has those — so this card starts at zero and the commit's reply fills each
 * item's snapshot in. `entryMacros` reads the snapshots in preference to `macros`, so the day's
 * numbers are right from the reply onwards; the window before it is the length of the commit,
 * and the card carries the pending mark throughout it.
 */
export function draftCard(
  draft: ProposeResponse, kept: EditedItem[], entryId: string, itemIds: string[], at: Date,
  note: string | undefined, labelSeq: number | null = null,
): LoggedFood {
  const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const grams = Math.round(kept.reduce((sum, item) => sum + item.grams, 0) * 10) / 10;
  const name = draft.labelFood?.name
    ?? (kept.length === 1 ? kept[0].label : `${kept.length} items`);
  // The label item is sent as the placeholder and its grams (A030); the card says the same.
  const sent = kept.map((item) => item.seq === labelSeq
    ? { ...item, foodRefId: LABEL_FOOD_PLACEHOLDER_REF, qty: item.grams, unit: "g" } : item);
  const items: LoggedItem[] = sent.map((item, i) => ({
    id: itemIds[i], seq: i + 1, food_ref_id: item.foodRefId as string,
    grams: item.grams, qty: item.qty, unit: item.unit,
    snapshot: {}, foodId: `catalog:${item.catalogFoodRevisionId ?? 0}`,
    name: item.label, portionLabel: `${item.qty} ${item.unit}`, macros: zero,
  }));
  return {
    id: entryId, foodId: items[0]?.foodId ?? "capture", name,
    portionLabel: sent.length === 1 ? `${sent[0].qty} ${sent[0].unit}` : `${sent.length} items`,
    qty: 1, grams, macros: zero,
    ...(note?.trim() ? { note: note.trim() } : {}),
    items, at: at.toISOString(),
  };
}
