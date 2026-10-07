/**
 * Portion follow-ups on the capture review sheet (owner, 2026-09-30, Option A): "I had a turkey
 * sandwich with cheese" names no size, so the review asks "How much of the turkey sandwich did you have?" and
 * offers the matched food's own portions as answers. No model call: the model already marked the
 * gap (qty 1, unit whole, confidence under 0.6, per lib/ai/prompts.ts UNITS and CONFIDENCE), and
 * the portions are the ones the sheet has already loaded.
 *
 * Pure. No I/O.
 */

import { LOW_CONFIDENCE } from "@/lib/capture/presentation";
import type { DraftItem } from "@/lib/capture/types";
import type { CachedPortion } from "@/lib/db/catalog-cache";

/** At most this many questions per capture, least confident item first. */
export const MAX_FOLLOW_UPS = 2;
/** At most this many answers per question, the food's default portion first. */
export const MAX_CHOICES = 4;

export type FollowUp = {
  seq: number;
  question: string;
  choices: CachedPortion[];
  /** The portion the item uses now, when it is one of the choices. */
  answeredPortionId: number | null;
};

/** The item as the sheet currently shows it: only what the selection reads. */
export type FollowUpItem = { seq: number; removed?: boolean; portionId: number | null };

/** The model's rule for "no amount given": one whole, and nothing more specific. */
export function gaveNoAmount(item: Pick<DraftItem, "qty" | "unit">): boolean {
  return item.unit === "whole" && item.qty <= 1;
}

/** "a Turkey sandwich" → "turkey sandwich"; an acronym such as "BLT" keeps its capitals. */
export function followUpSubject(label: string): string {
  const bare = label.trim().replace(/^(a|an|the|some|my)\s+/i, "");
  return /^[A-Z][a-z]/.test(bare) ? bare.charAt(0).toLowerCase() + bare.slice(1) : bare;
}

function choicesFrom(portions: CachedPortion[]): CachedPortion[] {
  const usable = portions.filter((p) => Number.isFinite(p.gramWeight) && p.gramWeight > 0);
  return [...usable.filter((p) => p.isDefault), ...usable.filter((p) => !p.isDefault)]
    .slice(0, MAX_CHOICES);
}

/**
 * Which items get a question. Chosen from the proposal as the server sent it, so the questions do
 * not reshuffle while the user edits; an item the user removed, or one whose current match has no
 * portions to offer, gets none.
 */
export function portionFollowUps<T extends FollowUpItem>(
  proposed: readonly DraftItem[],
  current: readonly T[],
  portionsOf: (item: T) => CachedPortion[],
): FollowUp[] {
  return proposed
    .filter((item) => item.confidence < LOW_CONFIDENCE && gaveNoAmount(item))
    .sort((a, b) => a.confidence - b.confidence || a.seq - b.seq)
    .flatMap((item) => {
      const shown = current.find((row) => row.seq === item.seq);
      if (!shown || shown.removed) return [];
      const choices = choicesFrom(portionsOf(shown));
      if (choices.length === 0) return [];
      const answered = choices.some((p) => p.id === shown.portionId) ? shown.portionId : null;
      return [{ seq: item.seq, question: `How much of the ${followUpSubject(item.label)} did you have?`,
        choices, answeredPortionId: answered }];
    })
    .slice(0, MAX_FOLLOW_UPS);
}
