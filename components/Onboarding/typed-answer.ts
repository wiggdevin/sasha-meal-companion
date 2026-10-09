/**
 * Onboarding v2 — reads one typed answer from the dock's text composer (live QA 2026-10-07,
 * defect 2: the composer was an empty box; the owner: "typing must work").
 *
 *   1. The question being asked reads a bare answer in its own US unit ("34" while asking age,
 *      "5 10" while asking height, "170" while asking weight) — the person answered that question,
 *      so the value is confirmed (high band). Safety runs first even here.
 *   1b. A list of short answers ("lose fat, 34, 5 10, 170 lb") is read piece by piece with the
 *      same parsers as the fact editors (`lib/profile/height-parse.ts`): a piece that is plainly a
 *      height, a weight in pounds or an age is confirmed. A bare number in a list is an age when
 *      13–110, a weight in pounds above that; a lone "6" is never guessed to be a height there.
 *   2. Anything else goes to `extractOnboardingFacts` (lib/onboarding/extract-client.ts): the local
 *      safety check, the zero-model fast path, then the bounded model call for goal / activity /
 *      cooking effort only. When the model leg does not answer (budget, offline, failure) its local
 *      reading still counts, so the flow keeps going.
 */
import { extractOnboardingFacts, type OnboardingBlockedReason } from "@/lib/onboarding/extract-client";
import type { FastPathFacts } from "@/lib/coach/onboarding-fast-path";
import { onboardingSafetyCheck } from "@/lib/coach/onboarding-safety";
import type { OnboardingFactKey } from "@/lib/coach/ui-blocks";
import { parseAge, parseHeight, parseWeight } from "@/lib/profile/height-parse";

export type TypedAnswer =
  | { status: "ok"; facts: FastPathFacts; callsUsed: number }
  | { status: "blocked"; reason: OnboardingBlockedReason; callsUsed: number }
  | { status: "unread"; callsUsed: number };

const CONFIRMED = 1;
/** A bare answer to the question on screen, read in that question's own unit. */
function contextual(text: string, asking: OnboardingFactKey | null, now: Date): FastPathFacts | null {
  if (asking === "birthYear") {
    const age = parseAge(text);
    if (age !== null) return { birthYear: now.getUTCFullYear() - age, confidence: { birthYear: CONFIRMED } };
  }
  if (asking === "heightCm") {
    const height = parseHeight(text);
    if (height) return { heightCm: height.cm, confidence: { heightCm: CONFIRMED } };
  }
  if (asking === "weightKg") {
    const weight = parseWeight(text);
    if (weight) return { weightKg: weight.kg, confidence: { weightKg: CONFIRMED } };
  }
  return null;
}

/** A comma, semicolon or line separated list of short answers, each piece read on its own. Only
 *  the body facts are read here; the goal and the rest go to the extract client. */
export function readAnswerList(text: string, now = new Date()): FastPathFacts | null {
  const pieces = text.split(/[,;\n]+/).map((piece) => piece.trim()).filter((piece) => piece !== "");
  if (pieces.length < 2) return null;
  const out: FastPathFacts = { confidence: {} };
  for (const piece of pieces) {
    const height = parseHeight(piece, { allowBare: false });
    if (height && out.heightCm === undefined) {
      out.heightCm = height.cm; out.confidence.heightCm = CONFIRMED; continue;
    }
    const weight = parseWeight(piece, { allowBare: false });
    if (weight && out.weightKg === undefined) {
      out.weightKg = weight.kg; out.confidence.weightKg = CONFIRMED; continue;
    }
    const age = parseAge(piece);
    if (age !== null && out.birthYear === undefined) {
      out.birthYear = now.getUTCFullYear() - age; out.confidence.birthYear = CONFIRMED; continue;
    }
    const bareWeight = /^\d{3}(?:\.\d+)?$/.test(piece) ? parseWeight(piece) : null;
    if (bareWeight && out.weightKg === undefined) {
      out.weightKg = bareWeight.kg; out.confidence.weightKg = CONFIRMED;
    }
  }
  return Object.keys(out.confidence).length > 0 ? out : null;
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
  const listed = readAnswerList(text, now);
  const result = await (opts.extract ?? extractOnboardingFacts)(text, { callsUsed, now });
  if (result.status === "blocked") {
    return { status: "blocked", reason: result.blockedReason ?? "allergy_or_condition", callsUsed: result.callsUsed };
  }
  // A list piece read by the shared parsers wins over the sentence reader's guess for that field.
  const facts = listed
    ? { ...result.facts, ...listed, confidence: { ...result.facts.confidence, ...listed.confidence } } as FastPathFacts
    : result.facts as FastPathFacts;
  const keys = Object.keys(facts).filter((key) => key !== "confidence");
  return keys.length > 0
    ? { status: "ok", facts, callsUsed: result.callsUsed }
    : { status: "unread", callsUsed: result.callsUsed };
}
