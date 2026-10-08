"use client";

/**
 * Onboarding v2: free text (typed, or a transcript) to `OnboardingFacts`, for the opener and facts
 * beats (2026-10-07 live QA: "the AI chat and voice chat didn't work" — nothing called the route).
 *
 * In this order, and a stop is final:
 *   1. the local safety check (lib/coach/onboarding-safety.ts, which replays the W5b corpus:
 *      tests/onboarding/extract-safety-corpus.test.ts). Allergy, condition, medicine or symptom
 *      text is read by nothing — no regex, no model — and answers `blocked`, so the UI opens the
 *      allergy/condition card instead;
 *   2. the zero-model fast path (lib/coach/onboarding-fast-path.ts);
 *   3. `POST /api/onboarding/extract`, only when the fast path left goal, activity or cooking
 *      effort below the high band and this session still has model calls left. The server
 *      re-runs the safety check, redacts age and sex, enforces the per-account budget and the
 *      shared limiter; the model can set only goal/activity/cookingEffort/dietFlags.
 *
 * The merge keeps, per field, the higher confidence (the fast path wins a tie), so a model answer
 * never replaces a stated number. `display` echoes the numbers in the account's units: feet and
 * inches and pounds by default (lib/onboarding/units.ts); storage stays metric.
 */
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { onboardingCallBudgetRemaining } from "@/lib/coach/onboarding-call-budget";
import { extractFastPath } from "@/lib/coach/onboarding-fast-path";
import { onboardingSafetyCheck, type OnboardingSafetyVerdict } from "@/lib/coach/onboarding-safety";
import {
  ONBOARDING_FACT_KEYS, onboardingConfidenceBand, onboardingFactsSchema,
  type OnboardingFactKey, type OnboardingFacts,
} from "@/lib/coach/ui-blocks";
import {
  ageFromBirthYear, displayHeight, displayHeightShort, displayWeight, ONBOARDING_DEFAULT_UNITS,
  type OnboardingUnits,
} from "@/lib/onboarding/units";

export type OnboardingBlockedReason =
  Extract<OnboardingSafetyVerdict, { blocked: true }>["reason"];

/** What the playback sentence echoes, in the account's units. Absent: the field is not set. */
export type OnboardingFactsDisplay = {
  height?: string;
  heightShort?: string;
  weight?: string;
  age?: number;
};

export type OnboardingExtractResult = {
  /**
   * ok: facts read (fast path, model or both). blocked: safety text, nothing read.
   * budget_exceeded / failed / offline: the model leg did not answer; `facts` still holds the
   * fast path's reading, so the flow continues with whatever was understood locally.
   */
  status: "ok" | "blocked" | "budget_exceeded" | "failed" | "offline";
  facts: OnboardingFacts;
  /** Set only for `blocked`. */
  blockedReason?: OnboardingBlockedReason;
  /** True when this call reached the route (counts toward the caller's session total). */
  modelCalled: boolean;
  /** The caller's session count after this call; pass it back as `callsUsed` next time. */
  callsUsed: number;
  display: OnboardingFactsDisplay;
};

export type ExtractOptions = {
  /** Model calls this onboarding session already made (the draft keeps it). Default 0. */
  callsUsed?: number;
  units?: OnboardingUnits;
  now?: Date;
  online?: boolean;
  account?: AccountHandle;
  fetchImpl?: typeof fetch;
};

/** Fields only the model can improve; the others are the fast path's alone (privacy rule). */
const MODEL_FIELDS: readonly OnboardingFactKey[] = ["goal", "activity", "cookingEffort"];

const BLOCKED_REASONS: readonly OnboardingBlockedReason[] = ["medical", "allergy_or_condition", "symptom"];

const routeAnswer = (value: unknown):
  | { status: "ok"; facts: OnboardingFacts }
  | { status: "blocked"; reason: OnboardingBlockedReason }
  | { status: "budget_exceeded" | "failed" }
  | null => {
  if (typeof value !== "object" || value === null) return null;
  const status = (value as { status?: unknown }).status;
  if (status === "blocked") {
    const reason = (value as { reason?: unknown }).reason;
    return { status, reason: BLOCKED_REASONS.includes(reason as OnboardingBlockedReason)
      ? reason as OnboardingBlockedReason : "allergy_or_condition" };
  }
  if (status === "budget_exceeded" || status === "failed") return { status };
  if (status !== "ok") return null;
  const parsed = onboardingFactsSchema.safeParse((value as { facts?: unknown }).facts);
  return parsed.success ? { status: "ok", facts: parsed.data } : null;
};

/** Per field, the higher confidence wins; `primary` (the fast path) wins a tie. */
export function mergeOnboardingFacts(primary: OnboardingFacts, secondary: OnboardingFacts): OnboardingFacts {
  const out: Record<string, unknown> = {};
  const confidence: Partial<Record<OnboardingFactKey, number>> = {};
  for (const key of ONBOARDING_FACT_KEYS) {
    const a = primary[key];
    const b = secondary[key];
    const ca = primary.confidence[key];
    const cb = secondary.confidence[key];
    const useB = b !== undefined && Number.isFinite(cb)
      && (a === undefined || !Number.isFinite(ca) || (cb as number) > (ca as number));
    if (useB) { out[key] = b; confidence[key] = cb; } else if (a !== undefined && Number.isFinite(ca)) {
      out[key] = a; confidence[key] = ca;
    }
  }
  return { ...(out as Omit<OnboardingFacts, "confidence">), confidence };
}

export function onboardingFactsDisplay(
  facts: Pick<OnboardingFacts, "heightCm" | "weightKg" | "birthYear">,
  units: OnboardingUnits = ONBOARDING_DEFAULT_UNITS,
  now: Date = new Date(),
): OnboardingFactsDisplay {
  const height = displayHeight(facts.heightCm, units.height);
  const weight = displayWeight(facts.weightKg, units.weight);
  const age = ageFromBirthYear(facts.birthYear, now);
  return {
    ...(height ? { height, heightShort: displayHeightShort(facts.heightCm, units.height) } : {}),
    ...(weight ? { weight } : {}),
    ...(age !== null ? { age } : {}),
  };
}

function needsModel(facts: OnboardingFacts): boolean {
  return MODEL_FIELDS.some((key) => onboardingConfidenceBand(facts.confidence[key]) !== "high");
}

export async function extractOnboardingFacts(
  text: string, opts: ExtractOptions = {},
): Promise<OnboardingExtractResult> {
  const now = opts.now ?? new Date();
  const units = opts.units ?? ONBOARDING_DEFAULT_UNITS;
  const callsUsed = Number.isFinite(opts.callsUsed) && (opts.callsUsed as number) >= 0
    ? Math.floor(opts.callsUsed as number) : 0;
  const value = typeof text === "string" ? text.trim().slice(0, 2_000) : "";
  const done = (status: OnboardingExtractResult["status"], facts: OnboardingFacts,
    modelCalled: boolean, blockedReason?: OnboardingBlockedReason): OnboardingExtractResult => ({
    status, facts, modelCalled, callsUsed: callsUsed + (modelCalled ? 1 : 0),
    ...(blockedReason ? { blockedReason } : {}),
    display: onboardingFactsDisplay(facts, units, now),
  });
  if (!value) return done("ok", { confidence: {} }, false);

  const safety = onboardingSafetyCheck(value);
  if (safety.blocked) return done("blocked", { confidence: {} }, false, safety.reason);

  const local = extractFastPath(value, now) as OnboardingFacts;
  if (!needsModel(local)) return done("ok", local, false);
  if (!onboardingCallBudgetRemaining(callsUsed)) return done("budget_exceeded", local, false);
  const online = opts.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  if (!online) return done("offline", local, false);

  const h = opts.account ?? accountHandle();
  let response: Response;
  try {
    response = await accountFetch(h, "/api/onboarding/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value, callsUsedThisSession: callsUsed }),
    }, { budget: "propose", fetchImpl: opts.fetchImpl });
  } catch (e) {
    rethrowAccountChanged(e);
    return done("failed", local, false);
  }
  // A limiter refusal (429) reached no model; any other error status is a plain failure.
  if (!response.ok) return done(response.status === 429 ? "budget_exceeded" : "failed", local, false);
  let body: unknown;
  try {
    body = await accountJson<unknown>(h, response);
  } catch (e) {
    rethrowAccountChanged(e);
    return done("failed", local, false);
  }
  const answer = routeAnswer(body);
  if (!answer) return done("failed", local, false);
  // The server re-ran the safety check; a refusal there is a refusal here, nothing kept.
  if (answer.status === "blocked") return done("blocked", { confidence: {} }, false, answer.reason);
  if (answer.status === "budget_exceeded") return done("budget_exceeded", local, false);
  if (answer.status !== "ok") return done("failed", local, true);
  return done("ok", mergeOnboardingFacts(local, answer.facts), true);
}
