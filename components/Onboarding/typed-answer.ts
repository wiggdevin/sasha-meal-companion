/**
 * Onboarding v2 — reads one typed answer from the dock's text composer (live QA 2026-10-07,
 * defect 2: the composer was an empty box; the owner: "typing must work").
 *
 * Local only, zero model calls, nothing leaves the phone:
 *   1. `onboardingSafetyCheck` (lib/coach/onboarding-safety.ts) runs first. A health, allergy or
 *      symptom statement is never parsed here; the shell points the person at the safety question.
 *   2. The question being asked reads a bare answer in its own US unit ("34" while asking age,
 *      "5 10" while asking height, "170" while asking weight) — the person answered that question,
 *      so the value is confirmed (high band).
 *   3. Otherwise `extractFastPath` (lib/coach/onboarding-fast-path.ts) reads whatever it can, each
 *      field at its own confidence band (a bare number stays a ghost that needs one tap).
 *
 * UI-NEEDS (backend lane): the model step for free sentences ("trying to drop a few pounds before
 * summer") belongs in `lib/onboarding/extract-client.ts` as
 *   `extractOnboardingFacts(text, { asking, now }): Promise<TypedAnswer>`
 * with this same return type: run this local pass first, and call `/api/onboarding/extract` only
 * for what it left unread. `readTypedAnswer` is the one call the shell makes, so the swap is one
 * import.
 */
import { extractFastPath, type FastPathFacts } from "@/lib/coach/onboarding-fast-path";
import { onboardingSafetyCheck } from "@/lib/coach/onboarding-safety";
import type { OnboardingFactKey } from "@/lib/coach/ui-blocks";
import { ftInToCm } from "@/lib/units/height";
import { lbToKg } from "@/lib/health/units";

export type TypedAnswer =
  | { status: "ok"; facts: FastPathFacts }
  | { status: "blocked"; reason: "medical" | "allergy_or_condition" | "symptom" }
  | { status: "unread" };

const CONFIRMED = 1;

/** A bare answer to the question on screen, read in that question's own unit. */
function contextual(text: string, asking: OnboardingFactKey | null, now: Date): FastPathFacts | null {
  const norm = text.trim().toLowerCase().replace(/[’‘′]/g, "'").replace(/[″“”]/g, "\"");
  if (asking === "birthYear") {
    const match = /^(?:i'?m\s+)?(\d{2,3})(?:\s*(?:years?(?:\s*old)?|yrs?|yo))?$/.exec(norm);
    const age = match ? Number(match[1]) : NaN;
    if (age >= 13 && age <= 100) return { birthYear: now.getUTCFullYear() - age, confidence: { birthYear: CONFIRMED } };
  }
  if (asking === "heightCm") {
    const match = /^(\d)\s*(?:'|ft|feet|foot|\s)\s*(\d{1,2})?\s*(?:"|in|inches)?$/.exec(norm);
    if (match) {
      const ft = Number(match[1]);
      const inches = match[2] ? Number(match[2]) : 0;
      if (ft >= 3 && ft <= 8 && inches < 12) {
        return { heightCm: Math.round(ftInToCm(ft, inches) * 10) / 10, confidence: { heightCm: CONFIRMED } };
      }
    }
  }
  if (asking === "weightKg") {
    const match = /^(\d{2,3}(?:\.\d)?)\s*(?:lbs?|pounds?)?$/.exec(norm);
    const lb = match ? Number(match[1]) : NaN;
    if (lb >= 45 && lb <= 880) return { weightKg: Math.round(lbToKg(lb) * 10) / 10, confidence: { weightKg: CONFIRMED } };
  }
  return null;
}

export function readTypedAnswer(text: string, asking: OnboardingFactKey | null, now = new Date()): TypedAnswer {
  const verdict = onboardingSafetyCheck(text);
  if (verdict.blocked) return { status: "blocked", reason: verdict.reason };
  const direct = contextual(text, asking, now);
  if (direct) return { status: "ok", facts: direct };
  const found = extractFastPath(text, now);
  const keys = Object.keys(found).filter((key) => key !== "confidence");
  return keys.length > 0 ? { status: "ok", facts: found } : { status: "unread" };
}
