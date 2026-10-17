"use client";

/**
 * OD06 / W091: the coach's reply while it is still being written and checked.
 *
 * Before any draft text arrives this is the familiar Thinking bubble. Once the model starts writing
 * the final reply, its words appear here, muted, with a "Checking" line under them: nothing in a
 * draft has passed the reply checks yet, so it carries no cards or actions and reads as unfinished.
 * The saved reply replaces it. The draft words are hidden from screen readers (the transcript is a
 * live region, and every streamed word would be read out); the Thinking line speaks, then the
 * saved reply.
 */

import Thinking from "@/components/ui/Thinking";
import { workingCopy } from "@/components/WorkingLine";

export const DRAFT_CHECKING_COPY = "Checking this answer";

export default function CoachDraftBubble({ draft }: { draft: string }) {
  const writing = draft.trim() !== "";
  return <div className="flex justify-start">
    <span className="shell flex max-w-[82%] flex-col gap-2 rounded-[16px] px-4 py-3"
      style={{ background: "var(--grad-bubble)" }} data-draft={writing ? "true" : undefined}>
      {writing && <span aria-hidden="true"
        className="m-0 whitespace-pre-wrap break-words text-caption font-normal leading-label-md text-muted">
        {draft}
      </span>}
      <Thinking size="compact" label={writing ? DRAFT_CHECKING_COPY : workingCopy("sent")} />
    </span>
  </div>;
}
