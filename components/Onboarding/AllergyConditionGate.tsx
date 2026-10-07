"use client";

/**
 * Onboarding v2 lane 4 (safety): the tap-only allergy/condition question. It renders before any
 * food UI, for every account type, every time (BRIEF §4 "1:05" beat, §6 lane 4 acceptance).
 * Allergies and conditions are never inferred from speech or the game — this card and the existing
 * rule editor / `DietaryProfilePicker` are the only paths that can write one.
 *
 * "No, nothing" is the largest, most prominent tap target (most people have none, so the common
 * answer is the easy one) and unlocks food UI immediately — there is nothing to wait for. "Allergy
 * or rule" and "Clinician guidance" both open the same inline `DietaryProfilePicker` (it already
 * covers a one-food custom rule via its own `CustomRuleComposer`, not only catalog conditions, so
 * there is one real editor behind either button, not a second path that is only a label — GPT-6
 * Sol r5 BLOCK: "Allergy or rule" used to change local state and call `onAddRule` with no editor
 * ever opening, so "I'm done" could confirm having reviewed nothing). Neither button unlocks food
 * UI on the tap that opens it: `onRulesConfirmed` fires only once the account explicitly says it
 * is done editing, so a caller (`FoodsSafetyGate`) can re-read the account's filtered food list
 * before revealing anything — opening the editor must never itself be read as "no allergy; let's
 * eat" (GPT-6 Sol r1 BLOCK). Nothing here calls a model or sends any allergy/condition text
 * anywhere; it only routes taps to the plumbing that already owns the write.
 */
import { useState } from "react";
import Button from "@/components/ui/Button";
import DietaryProfilePicker from "./DietaryProfilePicker";

export type AllergySafetyAnswer = "none" | "rule" | "clinician";
type EditMode = "closed" | "rule" | "clinician";

export default function AllergyConditionGate({ onConfirmNone, onAddRule, onRulesConfirmed, answer }: {
  /** "No, nothing" tapped — the common, biggest answer. Unlocks food UI immediately. */
  onConfirmNone: () => void;
  /** "Allergy or rule" tapped — the caller owns what "the existing rule editor" means here
   *  (OnboardingFlow's own `jumpToRuleEditor` today; a future shell slot may do something else).
   *  This does not by itself unlock food UI; see `onRulesConfirmed`. */
  onAddRule: () => void;
  /** The account tapped "I'm done" after opening the rule editor or clinician guidance. The
   *  caller must re-read the account's filtered food choices before revealing any food UI — a
   *  rule saved here can change what `starterChoices()` returns, and a cached pre-edit list would
   *  show a food the account just excluded. */
  onRulesConfirmed: () => void;
  /** The confirmed answer so far, if any — lets a caller re-render this gate as already answered
   *  without losing the "renders before any food UI" guarantee (see `FoodsSafetyGate`). */
  answer?: AllergySafetyAnswer | null;
}) {
  const [mode, setMode] = useState<EditMode>("closed");

  return (
    <div className="flex flex-col gap-4" data-testid="allergy-condition-gate">
      <p className="m-0 text-body text-charcoal">
        Anything you must never eat, or anything a clinician&rsquo;s told you to follow?
      </p>
      <Button size="lg" block variant="primary" aria-pressed={answer === "none"}
        onClick={onConfirmNone}>
        No, nothing
      </Button>
      <div className="flex gap-2">
        <Button size="sm" variant="tertiary" aria-expanded={mode === "rule"}
          onClick={() => { setMode((current) => current === "rule" ? "closed" : "rule"); onAddRule(); }}>
          Allergy or rule
        </Button>
        <Button size="sm" variant="tertiary" aria-expanded={mode === "clinician"}
          onClick={() => setMode((current) => current === "clinician" ? "closed" : "clinician")}>
          Clinician guidance
        </Button>
      </div>
      {(mode === "rule" || mode === "clinician") && <DietaryProfilePicker />}
      {mode !== "closed" && <Button size="sm" variant="secondary" onClick={onRulesConfirmed}>
        I&rsquo;m done — continue
      </Button>}
    </div>
  );
}
