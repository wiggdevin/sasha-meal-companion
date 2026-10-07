"use client";

/**
 * Onboarding v2 lane 4: the ordering guarantee BRIEF §6 lane 4 names as its first acceptance
 * criterion — "the allergy card always renders before any food UI, every account type, every
 * time." This is the one place that holds that rule so neither the legacy falling-food game nor
 * the pilot/open-world top-pick chips can render ahead of it, however the eventual shell (L2's
 * slots) ends up calling this.
 *
 * `confirmed` is a plain boolean, not the richer `AllergySafetyAnswer` union, on purpose: the
 * caller decides when it is actually safe to reveal food UI, which is "No, nothing" tapped, or
 * `onRulesConfirmed` fired after a rule/clinician edit AND the account's food choices have been
 * re-read (GPT-6 Sol r1 BLOCK — a rule saved mid-edit must not be hidden behind a stale, pre-edit
 * `choices` list). This component never guesses that for the caller.
 */
import type { ReactNode } from "react";
import AllergyConditionGate, { type AllergySafetyAnswer } from "./AllergyConditionGate";

export default function FoodsSafetyGate({ confirmed, answer, onConfirmNone, onAddRule,
  onRulesConfirmed, children }: {
  /** True only once it is safe to reveal food UI — see the module doc above. */
  confirmed: boolean;
  /** Cosmetic only (which button reads as pressed); never drives the reveal by itself. */
  answer?: AllergySafetyAnswer | null;
  onConfirmNone: () => void;
  onAddRule: () => void;
  onRulesConfirmed: () => void;
  /** Any food UI — the legacy game or the pilot/open-world chip fallback — reached only once
   *  `confirmed` is true. */
  children: ReactNode;
}) {
  if (!confirmed) {
    return <AllergyConditionGate onConfirmNone={onConfirmNone} onAddRule={onAddRule}
      onRulesConfirmed={onRulesConfirmed} answer={answer} />;
  }
  return <>{children}</>;
}
