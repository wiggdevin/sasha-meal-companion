"use client";

import Sheet from "@/components/Sheet";
import AiLabel from "@/components/ui/AiLabel";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import type { DayProjection } from "@/components/ProjectedDayTotals";
import CaptureDraftEditor, {
  type CaptureDraftEdits,
} from "@/components/coach/editors/CaptureDraftEditor";
import type { CaptureDetails, CaptureDetailsSpec } from "@/components/coach/editors/CaptureMealDetails";
import { spendNote, type DraftEdits } from "@/lib/capture-client";
import type { ProposeResponse } from "@/lib/capture/types";
import { useCaptureRevisions } from "@/components/coach/editors/useCaptureRevisions";
import type { SaveResult } from "@/lib/log/outcome";
import type { SlotId } from "@/lib/types";
import LoggedBeforeLine from "@/components/LoggedBeforeLine";

export default function CaptureConfirm({
  draft, saving, message, slot, projection, details, onSave, onDismiss, onSearchManually,
}: {
  draft: ProposeResponse;
  saving: boolean;
  message?: string | null;
  slot?: SlotId;
  projection?: DayProjection;
  /** Offer the meal's name, time and "Save as recipe" (W125). */
  details?: CaptureDetailsSpec;
  /** The save's verdict: a refusal comes back as the shared alert, with the draft kept. */
  onSave: (edits: DraftEdits, saveLabelAsFood: boolean, slot?: SlotId,
    details?: CaptureDetails) => void | Promise<SaveResult | void>;
  onDismiss: () => void;
  onSearchManually?: () => void;
}) {
  const { portions, revisions, alternativeRevisions } = useCaptureRevisions(draft);
  const feedback = useActionFeedback();

  function commit(edits: CaptureDraftEdits): void {
    // Sent on the tap itself, as before; the shared feedback reads its verdict.
    const sent = edits.details !== undefined
      ? onSave(edits.items, edits.saveLabelAsFood, edits.slot, edits.details)
      : edits.slot === undefined ? onSave(edits.items, edits.saveLabelAsFood)
        : onSave(edits.items, edits.saveLabelAsFood, edits.slot);
    void feedback.run(async () => {
      const saved = await sent;
      if (saved && !saved.ok) throw new Error(saved.message);
    }, { kind: "commit",
      failureMessage: (cause) => cause instanceof Error ? cause.message : "That did not log. Try again." });
  }

  return <CaptureDraftEditor
    draft={{ proposal: draft, portions, revisions, alternativeRevisions,
      ...(slot === undefined ? {} : { slot }), ...(details ? { details } : {}),
      saving: saving || feedback.phase === "pending", message, commitLabel: "save",
      canSearchManually: onSearchManually ? "unmatched" : false, canEditSlot: false, showDismiss: false }}
    projection={projection}
    onCommit={commit}
    onSearchManually={() => onSearchManually?.()}
    onDismiss={onDismiss}
    autoFocusGrams
    renderLayout={({ body, footer }) => (
      <Sheet title="Check this" subtitle={spendNote(draft.spend)} onClose={onDismiss} footer={footer}>
        <div className="flex flex-col gap-3 px-1">
          <AiLabel provenance={draft.provenance} className="self-start" />
          <LoggedBeforeLine refs={draft.items.map((item) => item.foodRefId)} />
          {body}
        </div>
        <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
      </Sheet>
    )}
  />;
}
