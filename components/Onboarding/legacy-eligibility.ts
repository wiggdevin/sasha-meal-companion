/**
 * The legacy profile form's pace eligibility (audit 2026-10-10 F13: A087, A088, A092, A093).
 *
 * The form now asks the safety round (`SafetyRound`, the v2 beat) before the goal, and reads the
 * account's stored holds (`useStoredEligibility`, the server's own two reads), so its preview, its
 * pace field and its save agree with what the server writes. Until both are known — the round not
 * answered (a flow opened past it) or the stored read still loading or failed — the plan holds the
 * pace at 0: maintenance calories, the same plan the server writes for any hold. It never guesses
 * "no hold" from a question nobody answered.
 *
 * Age: the derivation counts years by birth year (the server's stored-birth-year rule). In the
 * calendar year that count reaches 18 the form asks for the full date of birth, and a 17-year-old
 * whose birthday is still ahead meets the friendly stop instead of a plan.
 */
import { mergeEligibility } from "@/components/Onboarding/v2/stored-eligibility";
import { safetyAnswersFrom, type SafetyRound } from "@/components/Onboarding/v2/plan-answers";
import {
  adultAgeUnconfirmed, eligibilityFromSafetyAnswers, isMinorOn, RATE_HOLDS, type TargetEligibility,
} from "@/lib/profile/rate-eligibility";
import type { OnboardingState } from "@/lib/profile/onboarding-state";

/** Why the plan holds the pace although no hold was found: the round, or the stored read. */
export type PaceCheck = "answered" | "unanswered" | "unread";

export type LegacyEligibility = {
  /** What the preview, the required fields and the save are built under. */
  eligibility: TargetEligibility;
  /** Only the holds actually found (round + stored read), with no stand-in: what the goal step
   *  says when it leaves the pace out. */
  known: TargetEligibility;
  check: PaceCheck;
};

type StoredRead = { status: "loading" | "ready" | "failed"; eligibility: TargetEligibility | null };

/** Stands in for an unknown answer. `clinician_diet` changes nothing but the pace (kidney would
 *  also change protein), the same stand-in `serverHeldEligibility` uses. */
const UNCHECKED_HOLD = "clinician_diet" as const;

export function legacyEligibility(round: SafetyRound | null, stored: StoredRead): LegacyEligibility {
  const read = stored.status === "ready" ? stored.eligibility : null;
  const known = mergeEligibility(round ? eligibilityFromSafetyAnswers(safetyAnswersFrom(round)) : null, read);
  const check: PaceCheck = round === null ? "unanswered" : read === null ? "unread" : "answered";
  if (check === "answered") return { eligibility: known, known, check };
  return {
    eligibility: { ...known, holds: RATE_HOLDS.filter((hold) => hold === UNCHECKED_HOLD || known.holds.includes(hold)) },
    known,
    check,
  };
}

/** The birth year as the form holds it, or null while it is not a whole year. */
export function draftBirthYear(state: OnboardingState): number | null {
  const year = Number(state.body.birthYear.trim());
  return state.body.birthYear.trim() !== "" && Number.isInteger(year) ? year : null;
}

/** The form must ask for the full date of birth before it can tell an adult from a 17-year-old. */
export function needsBirthDate(state: OnboardingState, today: string): boolean {
  const year = draftBirthYear(state);
  return adultAgeUnconfirmed(year, today)
    && !(state.birthDate && state.birthDate.slice(0, 4) === String(year) && state.birthDate <= today);
}

/** Under 18 today by the form's own answers (the full date when it was asked), or a stored minor. */
export function legacyMinor(state: OnboardingState, today: string, eligibility: TargetEligibility): boolean {
  return eligibility.minor || isMinorOn(draftBirthYear(state), today, state.birthDate);
}
