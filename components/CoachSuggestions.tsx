"use client";

/**
 * The suggestion cards under a coach reply, and the rule that decides which of them may offer
 * "Log this". Moved out of components/CoachChat.tsx by T6 §6 so the chat file is the turn loop
 * and this one is the card list.
 */

import CoachSuggestionCard from "@/components/CoachSuggestion";
import type { CoachDraft, CoachSuggestion } from "@/lib/coach/types";

/**
 * The draft to open when "Log this" is tapped on one suggestion card, or null when that card
 * should not offer logging. `draft` is one turn-level object (at most one `draft_log_entry` call
 * per turn); `suggestions` names every food the reply mentions, independently. A suggestion only
 * opens the draft when its food is actually one of the draft's items — otherwise tapping "Log
 * this" under food A would silently open a draft for unrelated food B.
 */
export function draftForSuggestion(
  suggestion: CoachSuggestion, draft: CoachDraft | null,
): CoachDraft | null {
  if (!draft || suggestion.verdict !== "allowed") return null;
  const inDraft = draft.items.some((item) => (
    suggestion.foodRefId ? item.foodRefId === suggestion.foodRefId : item.name === suggestion.name
  ));
  return inDraft ? draft : null;
}

export default function CoachSuggestions({
  suggestions, draft, onOpenDraft,
}: { suggestions: CoachSuggestion[]; draft: CoachDraft | null;
  onOpenDraft: (draft: CoachDraft) => void }) {
  return (
    <>
      {suggestions.map((s, i) => {
        const draftForCard = draftForSuggestion(s, draft);
        return (
          <CoachSuggestionCard
            key={`${s.name}-${i}`}
            suggestion={s}
            onLog={draftForCard ? () => onOpenDraft(draftForCard) : undefined}
          />
        );
      })}
    </>
  );
}
