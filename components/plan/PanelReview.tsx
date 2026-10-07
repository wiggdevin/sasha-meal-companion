"use client";
/**
 * What a log from the Plan panel will file, shown before it files (2026-10-04, AI audit B3: a plate's
 * "Log it" used to commit a second capture nobody had seen). The capture's own draft sits in the app's
 * capture editor (components/coach/editors/CaptureDraftEditor.tsx), inside the meal card like the rest
 * of the flow: each food, its portion and its rule check, editable. Its "Log it" commits through
 * `onConfirm`; the button then confirms in place ("Logged", a short haptic) and the flow closes once
 * the confirmation has held. Nothing is logged until that tap; "Dismiss" drops the draft.
 */
import { useEffect, useRef, useState } from "react";
import { useReducedMotionConfig } from "motion/react";
import CaptureDraftEditor from "@/components/coach/editors/CaptureDraftEditor";
import { useCaptureRevisions } from "@/components/coach/editors/useCaptureRevisions";
import Button from "@/components/ui/Button";
import AiLabel from "@/components/ui/AiLabel";
import { CONFIRM_MS, useButtonStatus } from "@/components/ui/useButtonStatus";
import { DOCK_CLEARANCE, springScrollTo } from "@/lib/dom/spring-scroll";
import type { DraftEdits } from "@/lib/capture-client";
import type { PanelDraft, PanelLogResult } from "@/lib/plan/photo-log";
import { CARD_SECTION } from "@/lib/design/meal-type";

class NotLogged extends Error {}

/** Room kept between the commit button's foot and the dock. */
const COMMIT_GAP = 12;

/**
 * Brings the review's commit above the dock when it appears (Kimi K4, 2026-10-04: "Log it" could open
 * under the dock, so nothing on screen said how to finish). The page moves on the morph spring, only
 * as far as it must, once the panel has laid out.
 */
function useCommitAboveDock(commit: React.RefObject<HTMLElement | null>, reduce: boolean) {
  useEffect(() => {
    let stop = () => {};
    const frame = requestAnimationFrame(() => {
      const element = commit.current;
      if (!element) return;
      const over = element.getBoundingClientRect().bottom - (window.innerHeight - DOCK_CLEARANCE - COMMIT_GAP);
      if (over <= 0) return;
      const root = document.scrollingElement ?? document.documentElement;
      stop = springScrollTo(root.scrollTop + over, reduce);
    });
    return () => { cancelAnimationFrame(frame); stop(); };
    // Once, when the review appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default function PanelReview({ pending, label, onConfirm, onCancel, onDone }: {
  pending: PanelDraft;
  /** The meal it files under ("Meal 2"). */
  label: string;
  onConfirm: (edits: DraftEdits) => Promise<PanelLogResult | null>;
  onCancel: () => void;
  /** Called once "Logged" has held, with the day the entry was filed on. */
  onDone: (filedDate: string) => void;
}) {
  const { portions, revisions, alternativeRevisions } = useCaptureRevisions(pending.draft);
  const reduce = useReducedMotionConfig() ?? false;
  const commitRow = useRef<HTMLDivElement | null>(null);
  useCommitAboveDock(commitRow, reduce);
  const status = useButtonStatus();
  const [message, setMessage] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);
  useEffect(() => {
    if (!filed) return;
    const timer = setTimeout(() => onDoneRef.current(filed), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [filed]);

  async function commit(edits: DraftEdits) {
    setMessage(null);
    const outcome = await status.run(async () => {
      const out = await onConfirm(edits);
      if (!out) throw new NotLogged("");
      if (!out.ok) throw new NotLogged(out.message);
      return out.date;
    });
    if (outcome.ok) setFiled(outcome.value);
    else if (outcome.error instanceof NotLogged && outcome.error.message) setMessage(outcome.error.message);
  }

  return <section aria-label={`Check before logging to ${label}`} data-panel-review="" className="flex min-w-0 flex-col gap-3">
    <div className="flex min-w-0 items-start justify-between gap-2">
      <h3 className={`m-0 min-w-0 ${CARD_SECTION}`}>Check before it’s logged to {label}</h3>
      <AiLabel provenance={pending.draft.provenance} className="mt-0.5" />
    </div>
    {filed ? <Button variant="primary" size="lg" block status="success" confirmLabel="Logged">Log it</Button>
      : <CaptureDraftEditor
        draft={{ proposal: pending.draft, portions, revisions, alternativeRevisions, slot: pending.slot,
          saving: status.status === "pending", message, commitLabel: "log",
          canSearchManually: false, canEditSlot: false, showDismiss: true }}
        onCommit={(edits) => { void commit(edits.items); }}
        onSearchManually={() => {}}
        onDismiss={onCancel}
        renderLayout={({ body, footer }) => <div className="flex flex-col gap-3 px-1">
          {body}
          <div ref={commitRow} data-review-commit="">{footer}</div>
        </div>} />}
  </section>;
}
