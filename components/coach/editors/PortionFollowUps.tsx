"use client";

import { useId } from "react";
import EditorPill from "@/components/coach/editors/EditorPill";
import { portionFollowUps, type FollowUpItem } from "@/lib/capture/follow-ups";
import type { DraftItem } from "@/lib/capture/types";
import type { CachedPortion } from "@/lib/db/catalog-cache";
import { gramsForPortion } from "@/lib/log/grams";

const CARD: React.CSSProperties = { background: "var(--grad-card)", boxShadow: "var(--shadow-card)" };
const CARD_CLASS = "rounded-2xl";
const META = "text-tiny font-normal text-muted";

/**
 * One or two "How much of the … did you have?" questions above the items (lib/capture/follow-ups.ts). A tap
 * sets the item's portion exactly as its own Portion pill does; skipping them is fine, and the
 * grams stepper below still edits the same value.
 */
export default function PortionFollowUps<T extends FollowUpItem>({
  proposed, items, portionsOf, onAnswer,
}: {
  proposed: readonly DraftItem[];
  items: readonly T[];
  portionsOf: (item: T) => CachedPortion[];
  onAnswer: (seq: number, patch: Record<string, unknown>) => void;
}) {
  const id = useId();
  const questions = portionFollowUps(proposed, items, portionsOf);
  if (questions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {questions.map((question) => (
        <div key={question.seq} role="group" aria-labelledby={`${id}-${question.seq}`}
          style={CARD} className={`flex flex-col gap-2 px-3.5 py-3 ${CARD_CLASS}`}>
          <span id={`${id}-${question.seq}`} className="text-caption font-normal">
            {question.question}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {question.choices.map((portion) => (
              <EditorPill key={portion.id} active={question.answeredPortionId === portion.id}
                onClick={() => onAnswer(question.seq, {
                  grams: gramsForPortion(portion, 1), qty: 1, unit: "portion", portionId: portion.id,
                })}>
                {portion.description} · {portion.gramWeight} g
              </EditorPill>
            ))}
          </div>
        </div>
      ))}
      <p className={`m-0 px-1.5 ${META}`}>Optional. You can set the grams below instead.</p>
    </div>
  );
}
