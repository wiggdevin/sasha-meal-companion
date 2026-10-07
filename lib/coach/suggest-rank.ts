import type { JevPayload, SuggestState } from "@/lib/ai/payloads";
import type { ScoreAnswer, ScoreQuestion } from "@/lib/ai/jev-types";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { SuggestionCandidate } from "@/lib/coach/suggest-candidates";
import type { SuggestInput } from "@/lib/coach/executors";
import { SLOT_LABELS } from "@/lib/meals";

export type JevAnswers = Record<string, ScoreAnswer>;
/** Phase 13 §9 R3: the port takes the builder's payload (lib/ai/payloads.ts), never raw state. */
export type JevPort = (
  payload: JevPayload<"suggest-options", Record<string, ScoreQuestion>>,
  options?: { userId?: string; deadlineMs?: number; signal?: AbortSignal },
) => Promise<JevAnswers | null>;

export { questionsFor } from "@/lib/coach/suggest-questions";

/** The complete ranking payload: no stored flags, notes, conditions, or dietary prose. */
export function rankingState(
  input: SuggestInput,
  candidates: readonly SuggestionCandidate[],
  pendingSlots: readonly { slot: string; label: string }[] | undefined,
): SuggestState {
  const id = input.slot ?? pendingSlots?.[0]?.slot ?? null;
  const pending = id === null ? undefined : pendingSlots?.find((slot) => slot.slot === id);
  const label = pending?.label ?? (input.slot ? SLOT_LABELS[input.slot] : null);
  return {
    slot: { id, label: timedLabel(label, candidates[0]?.meal) },
    wish: input.wish?.trim() || null,
    candidates: candidates.map(({ meal }, index) => ({
      index,
      foods: meal.items.map((item) => ({ name: item.name, grams: item.grams })),
      macros: { ...meal.totals },
    })),
  };
}

/**
 * "Meal 1" said nothing about the time of day, so Jev could not tell that scallops with a banana
 * is an odd 7:30 am breakfast (2026-10-03). The label now carries the meal type and the clock:
 * "Meal 1 — breakfast at 07:30".
 */
export function timedLabel(
  label: string | null, meal: Pick<ComposedMeal, "mealType" | "mealClock"> | undefined,
): string | null {
  const type = meal?.mealType && meal.mealType !== "other" ? meal.mealType : null;
  const when = meal?.mealClock ? `at ${meal.mealClock}` : null;
  const detail = [type, when].filter(Boolean).join(" ");
  if (!detail) return label;
  return label ? `${label} — ${detail}` : detail;
}

/**
 * Macro closeness alone made the leanest anchor win every time. A card's pairing fit (0–1, how
 * usual its foods are together for the meal) now weighs in: an unusual pairing keeps 60 % of its
 * rank, a usual one all of it.
 */
export const PAIRING_WEIGHT = 0.4;

export function suggestionRank(fit: number, jevScore: number | undefined, pairing = 1): number {
  const base = jevScore === undefined ? fit : fit * (jevScore / 2);
  return base * (1 - PAIRING_WEIGHT + PAIRING_WEIGHT * Math.max(0, Math.min(1, pairing)));
}

export function rankCandidates(
  candidates: readonly SuggestionCandidate[],
  answers: JevAnswers | null,
  kind: SuggestInput["kind"],
): { candidate: SuggestionCandidate; reason: string; jevRanked: boolean }[] {
  return candidates.map((candidate, position) => {
    const answer = answers?.[`plausible_${position}`];
    const jev = answer !== undefined && answer.confidence >= 0.60 ? answer.score : undefined;
    const plausibility = jev === undefined ? undefined : jev / 2;
    const rejected = plausibility !== undefined && plausibility < 0.50;
    const rank = suggestionRank(candidate.fit, jev, candidate.pairing ?? candidate.meal.pairing);
    const reason = jev === undefined
      ? `fits ${Math.round(candidate.fit * 100)} %`
      : `fits ${Math.round(candidate.fit * 100)} %, ${plausibilityLabel(kind, jev)}`;
    return { candidate, rank, reason, rejected, jevRanked: jev !== undefined };
  }).filter((row) => !row.rejected)
    .sort((a, b) => b.rank - a.rank || b.candidate.fit - a.candidate.fit
      || a.candidate.index - b.candidate.index)
    // `jevRanked`: a usable Jev answer ranked this card (its provenance, lib/coach/suggest.ts).
    .map(({ candidate, reason, jevRanked }) => ({ candidate, reason, jevRanked }));
}

function plausibilityLabel(kind: SuggestInput["kind"], value: number): string {
  if (value >= 1.5) return `natural ${kind}`;
  if (value >= 0.5) return `acceptable ${kind}`;
  return `not a ${kind}`;
}
