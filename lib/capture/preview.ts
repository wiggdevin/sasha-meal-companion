import { liveStrip } from "@/lib/log-client";
import type { EditedItem } from "@/lib/capture-client";
import type { ProposeResponse } from "@/lib/capture/types";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import type { Macros } from "@/lib/types";

type RevisionDraft = {
  proposal: Pick<ProposeResponse, "items">;
  revisions?: Record<number, CachedRevision>;
  alternativeRevisions?: Record<string, CachedRevision>;
};

/** A chosen match previews only with the revision that belongs to that exact match. */
export function selectedRevision(item: EditedItem, draft: RevisionDraft): CachedRevision | undefined {
  const original = draft.proposal.items.find((row) => row.seq === item.seq);
  const revision = item.foodRefId === original?.foodRefId ? draft.revisions?.[item.seq]
    : item.foodRefId ? draft.alternativeRevisions?.[item.foodRefId] : undefined;
  return revision?.revision_id === item.catalogFoodRevisionId ? revision : undefined;
}

export function projectedCaptureMacros(items: readonly EditedItem[], draft: RevisionDraft): Macros | null {
  return items.reduce<Macros | null>((total, item) => {
    const revision = selectedRevision(item, draft);
    if (!total || !revision || item.foodRefId === null) return null;
    const strip = liveStrip(revision, item.grams);
    return {
      kcal: total.kcal + strip.kcal,
      protein: total.protein + strip.protein,
      carbs: total.carbs + strip.carbs,
      fat: total.fat + strip.fat,
    };
  }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}
