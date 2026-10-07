"use client";

import { useEffect, useState } from "react";
import Sheet from "@/components/Sheet";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import { scanHeading } from "@/components/ScanConfirmSheet.heading";
import type { DayProjection } from "@/components/ProjectedDayTotals";
import BarcodeDraftEditor, {
  badgeFor, gramsFor, searchHintText, type BarcodeDraftEdits,
} from "@/components/coach/editors/BarcodeDraftEditor";
import { toCachedRevision, type BarcodeMatch, type BarcodeResponse } from "@/lib/barcode/client";
import { offPlanFor } from "@/lib/catalog-client";
import { commitLogEntry } from "@/lib/log-commit-client";
import { buildCommitRequest } from "@/lib/log-client";
import { catalogCard } from "@/lib/log/catalog-card";
import { savedFrom } from "@/lib/log/outcome";
import { NUTRITION_UNCHECKED_COPY, commitNutritionUnchecked } from "@/lib/nutrition-display";
import { mark, type TimingRun } from "@/lib/timing";
import type { SlotId } from "@/lib/types";

export { badgeFor, gramsFor, searchHintText };

export default function ScanConfirmSheet({
  response, slot, projection, onLogged, onClose, onSearch, onFavorite, run,
}: {
  response: BarcodeResponse;
  slot: SlotId;
  projection?: DayProjection;
  run?: TimingRun;
  /** `saved`: a word more for Today's one confirmation ("Saved. Nutrition not fully checked."). */
  onLogged: (entryId: string, saved?: string) => void;
  onClose: () => void;
  onSearch?: (hint: string) => void;
  onFavorite?: (foodRefId: string) => void;
}) {
  const feedback = useActionFeedback();
  const saving = feedback.phase === "pending";
  const [headingMatch, setHeadingMatch] = useState<BarcodeMatch | null>(
    response.status === "resolved" ? response.match : null,
  );

  useEffect(() => { mark("barcode", "confirm-shown", run); }, [run]);

  /** One save through the shared feedback: a refusal throws its reason, keeping the sheet and edits. */
  async function commit(edits: BarcodeDraftEdits): Promise<{ entryId: string; saved?: string }> {
    const at = new Date();
    const entryId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const match = edits.match;
    const revision = toCachedRevision(match, response.status === "not_found" ? "" : response.gtin14);
    const request = buildCommitRequest({
      entryId, eatenAt: at, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, slot, method: "barcode",
      items: [{ id: itemId, foodRefId: match.foodRefId, revision, grams: edits.grams, qty: edits.qty,
        unit: edits.portionId === null ? "g" : "portion", portionId: edits.portionId }],
    });
    const entry = catalogCard({
      revision, entryId, itemId, foodRefId: match.foodRefId, grams: edits.grams, qty: edits.qty, at,
      portion: match.portions.find((portion) => portion.id === edits.portionId) ?? null,
      flags: offPlanFor(match),
    });
    const result = await commitLogEntry(request, {
      timingPath: "barcode", run, optimistic: { date: request.local_date, entry },
    });
    const saved = savedFrom(result);
    if (!saved.ok) {
      console.warn("[scan] commit rejected", result.status, entryId);
      throw new Error(saved.message);
    }
    return { entryId, saved: commitNutritionUnchecked(result) ? NUTRITION_UNCHECKED_COPY : undefined };
  }

  async function logIt(edits: BarcodeDraftEdits): Promise<void> {
    const outcome = await feedback.run(() => commit(edits), {
      kind: "commit", failureMessage: (cause) => cause instanceof Error ? cause.message : "That did not log. Try again.",
    });
    if (outcome.ok) onLogged(outcome.value.entryId, outcome.value.saved);
  }

  const { title, subtitle } = scanHeading(response, headingMatch);

  return (
    <Sheet title={title} subtitle={subtitle} onClose={onClose}>
      {/* T0 source guard: the editor owns <WorkingLine active={saving} step="commit" /> now. */}
      <BarcodeDraftEditor
        draft={{ response, slot, saving, error: null, canSearchManually: onSearch !== undefined,
          canEditSlot: false, showSearchManually: response.status === "not_found", showDismiss: false }}
        projection={projection}
        onCommit={(edits) => void logIt(edits)}
        onSearchManually={(hint) => onSearch?.(hint)}
        onDismiss={onClose}
        onFavorite={onFavorite}
        onMatchChange={setHeadingMatch}
      />
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
    </Sheet>
  );
}
