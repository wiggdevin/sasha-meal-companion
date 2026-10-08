/**
 * Onboarding v2 — reads one typed answer from the dock's text composer (live QA 2026-10-07,
 * defect 2: the composer was an empty box; the owner: "typing must work").
 *
 *   1. The question being asked reads a bare answer in its own US unit ("34" while asking age,
 *      "5 10" while asking height, "170" while asking weight) — the person answered that question,
 *      so the value is confirmed (high band). Safety runs first even here.
 *   2. Anything else goes to `extractOnboardingFacts` (lib/onboarding/extract-client.ts): the local
 *      safety check, the zero-model fast path, then the bounded model call for goal / activity /
 *      cooking effort only. When the model leg does not answer (budget, offline, failure) its local
 *      reading still counts, so the flow keeps going.
 */
import { extractOnboardingFacts, type OnboardingBlockedReason } from "@/lib/onboarding/extract-client";
import type { FastPathFacts } from "@/lib/coach/onboarding-fast-path";
import { onboardingSafetyCheck } from "@/lib/coach/onboarding-safety";
import type { OnboardingFactKey } from "@/lib/coach/ui-blocks";
import { ftInToCm } from "@/lib/units/height";
import { lbToKg } from "@/lib/health/units";

export type TypedAnswer =
  | { status: "ok"; facts: FastPathFacts; callsUsed: number }
  | { status: "blocked"; reason: OnboardingBlockedReason; callsUsed: number }
  | { status: "unread"; callsUsed: number };

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

/** The contextual reading alone (pure; exported for tests). */
export function readAskedAnswer(text: string, asking: OnboardingFactKey | null, now = new Date()): FastPathFacts | null {
  return onboardingSafetyCheck(text).blocked ? null : contextual(text, asking, now);
}

export async function readTypedAnswer(text: string, asking: OnboardingFactKey | null, opts: {
  callsUsed?: number; now?: Date; extract?: typeof extractOnboardingFacts;
} = {}): Promise<TypedAnswer> {
  const now = opts.now ?? new Date();
  const callsUsed = opts.callsUsed ?? 0;
  const verdict = onboardingSafetyCheck(text);
  if (verdict.blocked) return { status: "blocked", reason: verdict.reason, callsUsed };
  const direct = contextual(text, asking, now);
  if (direct) return { status: "ok", facts: direct, callsUsed };
  const result = await (opts.extract ?? extractOnboardingFacts)(text, { callsUsed, now });
  if (result.status === "blocked") {
    return { status: "blocked", reason: result.blockedReason ?? "allergy_or_condition", callsUsed: result.callsUsed };
  }
  const keys = Object.keys(result.facts).filter((key) => key !== "confidence");
  return keys.length > 0
    ? { status: "ok", facts: result.facts as FastPathFacts, callsUsed: result.callsUsed }
    : { status: "unread", callsUsed: result.callsUsed };
}
