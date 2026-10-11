/**
 * "Save as my food" on a label capture (audit 2026-10-10 A030).
 *
 * The server saves the label as the account's own food only when the commit names it: one item
 * carries the placeholder ref and the body carries `label_food` (lib/server/log-label-food.ts).
 * The client used to send neither, so every label save with the toggle on was refused with 422.
 *
 * Pure: no I/O, no server import, so the capture sheet and the server read the same placeholder.
 */
import type { DraftEdits } from "@/lib/capture-client";
import type { ProposeResponse } from "@/lib/capture/types";
import type { LabelFoodWire } from "@/lib/log/contract";

/**
 * The all-zero uuid a label commit sends in place of a food_ref it cannot know yet. The server
 * mints the real ref and swaps it in; the placeholder never reaches the database.
 */
export const LABEL_FOOD_PLACEHOLDER_REF = "00000000-0000-4000-8000-000000000000";

/**
 * The seq of the item that becomes the account's own food, or null when nothing does.
 *
 * The label item is the draft's first item: a label capture proposes exactly one. It stops being
 * the label once the user removes it or picks another food for it — that is a choice of a catalog
 * food, not of the label.
 */
export function labelItemSeq(
  draft: ProposeResponse, edits: DraftEdits, saveLabelAsFood: boolean | undefined,
): number | null {
  if (saveLabelAsFood !== true || draft.method !== "label" || !draft.labelFood) return null;
  const first = draft.items[0];
  if (!first) return null;
  const edit = edits[first.seq] ?? {};
  if (edit.removed === true) return null;
  if (edit.foodRefId !== undefined && edit.foodRefId !== first.foodRefId) return null;
  return first.seq;
}

/** The `label_food` body, from the label the server read. The card-only warnings stay behind. */
export function labelFoodBody(label: NonNullable<ProposeResponse["labelFood"]>): LabelFoodWire {
  return {
    name: label.name,
    ...(label.brand ? { brand: label.brand } : {}),
    per100g: label.per100g,
    ...(label.ingredientsText ? { ingredientsText: label.ingredientsText } : {}),
    allergenTags: label.allergenTags,
  };
}
