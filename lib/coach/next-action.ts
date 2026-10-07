/**
 * Phase 13 §6 ("Next best action", rev 2 retained), slice 7: one deterministic chip under the
 * coach reply, proposing the single next thing worth doing — never a list, never a guess at
 * something the turn's own state does not already show. The candidate set is fixed and the
 * ranking is a plain priority weight over deterministic state flags (§6: "a fixed action set from
 * deterministic state flags only" — no raw text, no conditions, no notes ever reach this or the
 * optional Jev tie-break).
 *
 * Jev is consulted only when two candidates tie on weight, through the same fixed-question
 * `systemOne` path every other D0 call uses (lib/ai/typesafe.ts) — never with anything this
 * module could not already see: the tied candidate kinds themselves. A caller with no Jev port,
 * or one that declines or errors, still gets an answer: the fixed candidate order wins.
 *
 * Pure aside from the injected, optional async port. No direct I/O.
 */

export const NEXT_ACTION_KINDS =
  ["log_meal", "confirm_rule", "check_label", "pick_suggestion"] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

export type NextActionFlags = {
  /** Nothing logged for the account's requested local date (today or a scoped past date). */
  hasUnloggedMealToday: boolean;
  /** A stated dietary need or preference is waiting on the confirm card. */
  hasPendingProfileConfirmation: boolean;
  /** A food this turn touched has no allergen evidence yet ("unverified", "Check the label"). */
  hasUncheckedLabelFood: boolean;
  /** The turn already has real suggestions or ideas the user has not acted on. */
  hasSuggestionsAvailable: boolean;
};

export type NextActionCandidate = { kind: NextActionKind; label: string };

const LABEL: Record<NextActionKind, string> = {
  log_meal: "Log your next meal",
  confirm_rule: "Confirm this rule",
  check_label: "Check a label",
  pick_suggestion: "Pick from your suggestions",
};

/**
 * A pending confirmation and an unchecked label are equally urgent food-safety follow-ups.
 * Both outrank logging an unlogged meal; logging outranks picking a suggestion.
 */
const WEIGHT: Record<NextActionKind, number> = {
  log_meal: 2, confirm_rule: 3, check_label: 3, pick_suggestion: 1,
};

const FLAG_FOR: Record<NextActionKind, keyof NextActionFlags> = {
  log_meal: "hasUnloggedMealToday",
  confirm_rule: "hasPendingProfileConfirmation",
  check_label: "hasUncheckedLabelFood",
  pick_suggestion: "hasSuggestionsAvailable",
};

function eligible(flags: NextActionFlags): NextActionKind[] {
  return NEXT_ACTION_KINDS.filter((kind) => flags[FLAG_FOR[kind]]);
}

/** The fixed-question Jev port: exactly the tied candidate kinds in, one of them (or null) back.
 *  Mocked in tests — never called for real inside a pure unit test. */
export type NextActionJevPort = (
  tied: readonly NextActionKind[],
) => Promise<NextActionKind | null>;

export async function nextBestAction(
  flags: NextActionFlags, jevChoice?: NextActionJevPort,
): Promise<NextActionCandidate | null> {
  const candidates = eligible(flags);
  if (candidates.length === 0) return null;

  const topWeight = Math.max(...candidates.map((kind) => WEIGHT[kind]));
  // `candidates` is already in NEXT_ACTION_KINDS order (eligible() filters that fixed array), so
  // `tied` is too — tied[0] is the deterministic fallback the whole way through.
  const tied = candidates.filter((kind) => WEIGHT[kind] === topWeight);
  if (tied.length === 1) return { kind: tied[0], label: LABEL[tied[0]] };

  if (jevChoice) {
    const chosen = await jevChoice(tied).catch(() => null);
    if (chosen && tied.includes(chosen)) return { kind: chosen, label: LABEL[chosen] };
  }
  return { kind: tied[0], label: LABEL[tied[0]] };
}
