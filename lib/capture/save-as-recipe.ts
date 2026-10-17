/**
 * "Save as recipe" on the capture confirm sheet (W125, T2/T5): the meal just logged, kept as one
 * of the account's recipes (one serving, each food at the grams logged).
 *
 * Built from the commit's own answer where there is one: the server's stored items carry the real
 * food refs (the label item's minted ref included) and the revisions it pinned. A commit that was
 * only queued has no answer yet, so the draft's own refs are used and the label item, which has no
 * ref until the server makes one, is left out.
 *
 * A recipe still refuses an off-plan ingredient (R6, docs/decisions/2026-09-14): only foods whose
 * verdict is `allowed` go in, as the coach's `save_recipe` does; the rest are named so the sheet
 * can say so. Pure.
 */
import type { EditedItem } from "@/lib/capture-client";
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/capture/label-food";
import type { CommitResult } from "@/lib/log-commit-client";
import type { RecipeInput } from "@/lib/recipes-client";

/** The recipe's name: the meal's own, else its foods ("Chicken, rice and broccoli"). */
export function recipeName(title: string | undefined, kept: EditedItem[]): string {
  const own = title?.trim();
  if (own) return own.slice(0, 80);
  const labels = kept.map((item) => item.label.trim()).filter(Boolean);
  const joined = labels.length <= 1 ? (labels[0] ?? "Saved meal")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return joined.slice(0, 80);
}

export function captureRecipe(
  kept: EditedItem[], result: CommitResult, opts: { title?: string; labelSeq: number | null },
): { input: RecipeInput | null; left: string[] } {
  const stored = result.status === "ok"
    ? [...result.items].sort((a, b) => a.seq - b.seq) : null;
  const items: RecipeInput["items"] = [];
  const left: string[] = [];
  kept.forEach((item, i) => {
    // The commit numbers its items in this same order (buildCommitRequest: seq = index + 1).
    const row = stored?.find((s) => s.seq === i + 1);
    const foodRefId = row?.food_ref_id ?? (item.seq === opts.labelSeq ? null : item.foodRefId);
    const grams = row?.grams ?? item.grams;
    if (item.policy.verdict !== "allowed" || foodRefId === null
      || foodRefId === LABEL_FOOD_PLACEHOLDER_REF || !(grams > 0)) {
      left.push(item.label);
      return;
    }
    items.push({ seq: items.length + 1, foodRefId, qty: grams, unit: "g", grams, state: "raw",
      foodRevisionId: row ? row.food_revision_id : item.catalogFoodRevisionId });
  });
  if (items.length === 0) return { input: null, left };
  return { input: { name: recipeName(opts.title, kept), servings: 1, items }, left };
}
