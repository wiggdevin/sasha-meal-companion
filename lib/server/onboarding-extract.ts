import "server-only";

/**
 * Onboarding v2 (BRIEF.md §5): the one bounded extraction call. Three gates run before anything
 * is sent anywhere, in this exact order, and any of them stopping the call is final — no retry,
 * no silent downgrade to the other provider:
 *
 *   1. the local safety guard (lib/coach/onboarding-safety.ts) — a match means zero model calls;
 *      every demographic span `lib/coach/onboarding-fast-path.ts` recognizes (age, and who the
 *      person says they are) is also redacted from the text before anything is sent (a standing
 *      privacy rule, never an allowlisted field — tests/ai/no-demographics-payload.test.ts), and
 *      the model's reply schema has no place for either one to land even if asked;
 *   2. the per-session call budget, enforced server-side through the shared Postgres-backed rate
 *      limiter (lib/server/ratelimit.ts), keyed per user — NOT the client-reported count alone
 *      (Sol r1 BLOCK: a client that always sends 0 must still be stopped), and claimed once PER
 *      PROVIDER ATTEMPT, not once per request (Sol r2 BLOCK: a request that falls back from
 *      OpenRouter to Gemini makes two attempts and must spend two of the five, not one), and
 *      every retry callModel makes inside one leg claims its own slot before it is sent (Sol p0
 *      BLOCK 5: retries could otherwise exceed five real attempts); the client's own
 *      `callsUsedThisSession` is never read for the decision;
 *   3. callModel's own gates (lib/ai/call.ts): the registry, attestation, the circuit breaker
 *      and the spend cap, same as every other lane.
 *
 * Provider selection is "ask whichever is healthy", never a hard-coded provider (the owner's
 * instruction for this lane, given Gemini's current 403 project-denied outage): OpenRouter is
 * asked first when its key and attestation are both ready (the same rule
 * lib/ai/capture.ts's `captureOpenRouterReady` already uses for text/photo/label capture), and a
 * PROVIDER failure — capacity, timeout, a dropped connection — falls back to the Gemini pin. A
 * failure that is ours (a schema rejection, a refusal, the spend cap) propagates instead: a
 * second provider would only mask it and bill twice, same rule as `worthGemini` in capture.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertPinnedSdk, classifyFailure, generateStructured, isCapacityFailure, ProviderHttpError,
  SchemaRejection } from "@/lib/ai/adapter";
import { openRouterAttested } from "@/lib/ai/attestation";
import { onboardingExtractPayload } from "@/lib/ai/gemini-payloads";
import { onboardingExtractOpenRouterModel } from "@/lib/ai/models";
import {
  ONBOARDING_EXTRACT_MAX_OUTPUT_TOKENS,
} from "@/lib/ai/onboarding-extract-prompt";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { onboardingExtractOpenRouterPayload } from "@/lib/ai/openrouter-payloads";
import { openRouterConfigured } from "@/lib/ai/provider-env";
import {
  ONBOARDING_MAX_MODEL_CALLS, ONBOARDING_SESSION_WINDOW_SECONDS,
} from "@/lib/coach/onboarding-call-budget";
import { redactAgeAndSex, sanitizeDietFlags } from "@/lib/coach/onboarding-fast-path";
import { onboardingSafetyCheck, type OnboardingSafetyVerdict } from "@/lib/coach/onboarding-safety";
import {
  onboardingModelFactsProviderSchema, onboardingModelFactsSchema, type OnboardingFacts,
} from "@/lib/coach/ui-blocks";
import { HttpError } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export type OnboardingExtractOutcome =
  | { status: "blocked"; reason: Extract<OnboardingSafetyVerdict, { blocked: true }>["reason"] }
  | { status: "budget_exceeded" }
  | { status: "ok"; facts: OnboardingFacts; provider: "openrouter" | "google" }
  | { status: "failed" };

export type OnboardingExtractCtx = {
  userId: string;
  admin: SupabaseClient;
  /** Advisory only (see lib/coach/onboarding-call-budget.ts): the UI's own count, for its "how
   *  many do I have left" display. Never trusted for the budget itself — the server re-counts
   *  independently through the shared rate limiter, keyed on `userId`, so a client that always
   *  reports 0 is still stopped at ONBOARDING_MAX_MODEL_CALLS. */
  callsUsedThisSession: number;
};

export type OnboardingExtractDeps = {
  generateStructured?: typeof generateStructured;
  generateOpenRouter?: typeof generateOpenRouter;
};

const TIMEOUT_MS = 8_000;

/** Same readiness rule as lib/ai/capture.ts's `captureOpenRouterReady`: both the key and the
 *  attestation must be in place, or every call stays on the Gemini pin. */
export function onboardingExtractOpenRouterReady(): boolean {
  return openRouterConfigured() && openRouterAttested();
}

/**
 * The EXACT same failure vocabulary as lib/ai/capture.ts's `worthGemini` (Sol r1 BLOCK: an
 * earlier draft of this fell back for nearly any `Error`, including the spend cap and
 * programming errors, which the capture.ts predicate deliberately excludes). Only a genuine
 * PROVIDER failure — no capacity, no answer in time, the connection itself failing — is worth
 * asking the other provider. A schema rejection, an HttpError (the spend cap, an attestation
 * refusal), our own `refused:`-prefixed refusal, or anything else that is ours to fix is final:
 * a second provider would only mask it and bill twice.
 */
export function worthGeminiFallback(e: unknown): boolean {
  if (e instanceof HttpError || e instanceof SchemaRejection) return false;
  if (e instanceof ProviderHttpError || classifyFailure(e) === "timeout") return true;
  if (e instanceof TypeError && e.message === "fetch failed") return true;
  return e instanceof Error && !e.message.startsWith("refused:") && isCapacityFailure(e);
}

function boundedError(e: unknown): { name: string; message: string } {
  return e instanceof Error
    ? { name: e.name, message: e.message.slice(0, 500) }
    : { name: "UnknownError", message: "non-Error rejection" };
}

/**
 * Runs the one bounded extraction call, or stops before any I/O and says why. `text` must
 * already be whatever the caller is about to extract from (the opener's dictated or typed
 * reply) — this function re-checks the safety guard itself rather than trust a caller's own
 * check, because a refused call here must never depend on every caller remembering to ask first.
 */
/**
 * Claims one slot of the server-side budget, counted PER PROVIDER ATTEMPT, not per request (Sol
 * r2 BLOCK: counting once per request let one request that falls back from OpenRouter to Gemini
 * spend 2 of the 5 while the counter moved by 1). Called immediately before each of the two
 * provider calls below, so a request that falls back is correctly charged twice, and before
 * every retry inside callModel (`beforeRetry`), so a retry is charged too.
 * `enforceRateLimit` is fail-closed by default, so a limiter outage also stops the call here
 * rather than let it through unmetered.
 */
async function claimOneModelCall(userId: string): Promise<"ok" | "budget_exceeded"> {
  try {
    await enforceRateLimit(`onboarding-extract:budget:${userId}`,
      ONBOARDING_MAX_MODEL_CALLS, ONBOARDING_SESSION_WINDOW_SECONDS);
    return "ok";
  } catch (e) {
    if (e instanceof HttpError) return "budget_exceeded";
    throw e;
  }
}

/**
 * Defense in depth on the reply direction (Sol privacy-round WARN): the model's reply schema
 * has no demographic fields to set, but `dietFlags` is free text the model writes itself, and a
 * confused or hallucinated reply could still echo an age or who-the-person-says-they-are word
 * into one of its entries. Drops any such entry
 * (lib/coach/onboarding-fast-path.ts `sanitizeDietFlags`) before the facts ever leave this
 * function, dropping the now-orphaned confidence entry with it.
 */
function sanitizeModelFacts(facts: OnboardingFacts): OnboardingFacts {
  if (facts.dietFlags === undefined) return facts;
  const dietFlags = sanitizeDietFlags(facts.dietFlags);
  if (dietFlags !== undefined) return { ...facts, dietFlags };
  const { dietFlags: _droppedFlags, ...factsRest } = facts;
  const { dietFlags: _droppedConfidence, ...confidenceRest } = facts.confidence;
  return { ...factsRest, confidence: confidenceRest };
}

export async function runOnboardingExtraction(
  text: string, now: Date, ctx: OnboardingExtractCtx, deps: OnboardingExtractDeps = {},
): Promise<OnboardingExtractOutcome> {
  // `now` is kept in the signature for callers already built against it (the route, this
  // module's own earlier test suite); nothing here still needs a clock — the one field that
  // ever did (an age-to-year conversion) left the model's scope with the redaction below.
  void now;
  const safety = onboardingSafetyCheck(text);
  if (safety.blocked) return { status: "blocked", reason: safety.reason };

  // Standing privacy rule (tests/ai/no-demographics-payload.test.ts, coordinator ruling): who
  // the person says they are, and their age or birth year, reach no AI payload, ever — only
  // this account's own regex reader (lib/coach/onboarding-fast-path.ts) extracts either.
  // Redacting here, unconditionally, before either provider is ever built a payload, means this
  // holds regardless of whether a caller ran the fast path first (the same "never trust the
  // caller" rule the safety guard above already follows).
  const redacted = redactAgeAndSex(text);

  const structured = deps.generateStructured ?? generateStructured;
  const openRouter = deps.generateOpenRouter ?? generateOpenRouter;
  // Every provider ATTEMPT spends one slot, retries included (Sol p0 BLOCK 5): the first attempt
  // of each leg is claimed below before the call, and each retry inside callModel claims its own
  // slot through `beforeRetry` — a retry the budget cannot pay for is never sent.
  let budgetSpent = false;
  const beforeRetry = async (): Promise<boolean> => {
    if (await claimOneModelCall(ctx.userId) === "ok") return true;
    budgetSpent = true;
    return false;
  };
  const common = {
    userId: ctx.userId, admin: ctx.admin, schema: onboardingModelFactsSchema,
    maxOutputTokens: ONBOARDING_EXTRACT_MAX_OUTPUT_TOKENS, beforeRetry,
  };

  try {
    if (onboardingExtractOpenRouterReady()) {
      if (await claimOneModelCall(ctx.userId) === "budget_exceeded") {
        return { status: "budget_exceeded" };
      }
      try {
        const facts = await openRouter({
          ...common, payload: onboardingExtractOpenRouterPayload(redacted),
          modelId: onboardingExtractOpenRouterModel(),
          timeoutMs: TIMEOUT_MS, attemptTimeoutMs: TIMEOUT_MS, abandonOnCapacity: true,
        });
        return { status: "ok", facts: sanitizeModelFacts(facts), provider: "openrouter" };
      } catch (e) {
        if (!worthGeminiFallback(e)) throw e;
        console.warn("onboarding extraction fell back to gemini", { error: boundedError(e) });
      }
    }
    // The fallback leg is its own attempt and claims its own slot — whether or not OpenRouter
    // was tried first (it wasn't, if OpenRouter was never ready).
    if (await claimOneModelCall(ctx.userId) === "budget_exceeded") {
      return { status: "budget_exceeded" };
    }
    assertPinnedSdk();
    const facts = await structured({
      ...common, payload: onboardingExtractPayload(redacted),
      providerSchema: onboardingModelFactsProviderSchema,
      // generateStructured may retry (adapter.ts, up to 3 attempts); each retry is metered by
      // `beforeRetry` above, and `abandonOnCapacity` skips a retry on a capacity failure.
      timeoutMs: TIMEOUT_MS, abandonOnCapacity: true,
    });
    return { status: "ok", facts: sanitizeModelFacts(facts), provider: "google" };
  } catch (e) {
    console.error("onboarding extraction failed", { error: boundedError(e) });
    return budgetSpent ? { status: "budget_exceeded" } : { status: "failed" };
  }
}
