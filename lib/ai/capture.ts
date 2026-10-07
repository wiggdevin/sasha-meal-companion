/**
 * The only impure capture module (spec §7): it resolves the purpose, builds the two parts, hands
 * them to the adapter — which sends inline bytes or a Files API upload, deletes the provider file
 * in a finally, writes one ai_calls row per call and re-validates against zod — and translates
 * the adapter's failure vocabulary into the spec §5 status table.
 *
 * It never touches the database itself and never persists a draft.
 *
 * Owner request 2026-10-02: text, photo and label ask OpenRouter first (`captureOpenRouterReady`),
 * and the Gemini pair below is their fallback.
 *
 * 2026-10-06 (Gemini project denial, #gemini-fallback): voice (`voiceToItems`) got the opposite
 * wiring — Gemini stays PRIMARY (ctx.openRouterFallback, tried only once the Gemini pair above is
 * exhausted), so the app recovers onto Gemini on its own the moment Google restores access,
 * instead of staying pinned to OpenRouter the way text/photo/label now are.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyFailure, generateStructured, isCapacityFailure, MODELS, ProviderHttpError, SchemaRejection,
  type GenerateDeps, type RouteOverride,
} from "@/lib/ai/adapter";
import { openRouterAttested } from "@/lib/ai/attestation";
import { isPermissionDeniedFailure, worthAnotherModel } from "@/lib/ai/failures";
import { LANES } from "@/lib/ai/lanes";
import { captureOpenRouterModel, captureVoiceOpenRouterModel, modelProvider } from "@/lib/ai/models";
import { generateOpenRouter, type OpenRouterDeps } from "@/lib/ai/openrouter";
import {
  CAPTURE_TWIN, type CaptureOpenRouterPurpose, type OpenRouterPayload,
} from "@/lib/ai/openrouter-payloads";
import type { GeminiPayload } from "@/lib/ai/payloads";
import { PROMPTS } from "@/lib/ai/prompts";
import { openRouterConfigured } from "@/lib/ai/provider-env";
import { providerFallbackWorthTrying } from "@/lib/ai/provider-fallback";
import { CAPTURE_SCHEMAS, type CaptureItems, type CapturePurpose, type LabelNutrients } from "@/lib/ai/schemas";
import type { CaptureMethod } from "@/lib/capture/flags";
import { HttpError } from "@/lib/server/auth";

export const PURPOSE_BY_METHOD: Record<CaptureMethod, CapturePurpose> = {
  text: "textToItems", voice: "voiceToItems", label: "labelToNutrients", photo: "photoToItems",
};

export type CaptureCtx = { userId: string; admin: SupabaseClient } & (
  | { openRouter?: undefined; openRouterFallback?: undefined; inputHash?: string }
  | {
    /** The OpenRouter twin's payload: asked first when present (lib/server/capture.ts decides). */
    openRouter: OpenRouterPayload<CaptureOpenRouterPurpose>;
    openRouterFallback?: undefined;
    /** The Gemini payload's input hash, recorded on the OpenRouter row too. Required with
     *  `openRouter` (DeepSeek audit r2 on #334): without it the duplicate probe misses the row. */
    inputHash: string;
  }
  | {
    openRouter?: undefined;
    /** 2026-10-06: the OpenRouter twin's payload, tried only AFTER the Gemini pair below is
     *  exhausted (voiceToItems today — lib/server/capture.ts decides). */
    openRouterFallback: OpenRouterPayload<CaptureOpenRouterPurpose>;
    inputHash: string;
  });

/** A label reply that says no panel was visible is refused at parse time (lib/ai/call.ts
 *  UnusableReply): recorded schema_invalid, so it never reads as a draft to the duplicate probe. */
function refusalFor(purpose: CapturePurpose): ((value: unknown) => string | null) | undefined {
  if (purpose !== "labelToNutrients") return undefined;
  return (value) => ((value as LabelNutrients).labelReadable === false ? "no readable nutrition label" : null);
}
export type CaptureDeps = GenerateDeps & {
  generateOpenRouter?: typeof generateOpenRouter;
  openRouterDeps?: OpenRouterDeps;
};
export type CaptureOutput = {
  textToItems: CaptureItems; voiceToItems: CaptureItems;
  photoToItems: CaptureItems; labelToNutrients: LabelNutrients;
};

/** The other model on the same key (lib/ai/lanes.ts), and how ONE 20 s capture budget is split
 *  between the two, so both fit inside the propose route's 25 s client deadline. */
const FALLBACK = LANES.capture.fallback;
const CAPTURE_BUDGET_MS = 20_000;
const PRIMARY_BUDGET_MS = 9_000;
const FALLBACK_BUDGET_MS = 11_000;
/** The fallback prepares its media again, outside its own model clock (Grok audit round 6). */
const FALLBACK_PREPARE_MS = 1_500;
const MIN_FALLBACK_MS = 4_000;

/** What the fallback may spend after `elapsedMs` of the capture, or null when it cannot answer. */
export function fallbackBudgetMs(elapsedMs: number): number | null {
  const left = CAPTURE_BUDGET_MS - elapsedMs - FALLBACK_PREPARE_MS;
  return left < MIN_FALLBACK_MS ? null : Math.min(FALLBACK_BUDGET_MS, left);
}

/**
 * The Gemini primary's budget when `leftMs` of the capture remain, keeping room for the same-key
 * fallback (its media preparation plus its minimum), so a primary that times out never spends the
 * time the second model needs (Grok audit on #334). Null when there is no room for both: the
 * fallback model then runs alone on what is left. An untouched capture (20 s left) still gets 9 s.
 */
export function geminiPrimaryBudgetMs(leftMs: number): number | null {
  const primary = Math.min(PRIMARY_BUDGET_MS, leftMs - FALLBACK_PREPARE_MS - MIN_FALLBACK_MS);
  return primary >= MIN_FALLBACK_MS ? primary : null;
}

/** A model out of capacity, or one that never answered, is worth the other model. A key quota,
 *  a refused reply or the spend cap is not: the other model meets the same answer. */
function worthFallback(e: unknown): boolean {
  if (e instanceof HttpError || e instanceof SchemaRejection) return false;
  if (e instanceof Error && e.name === "AbortError") return true;
  return worthAnotherModel(e);
}

/**
 * Owner request 2026-10-02: text, photo and label capture ask OpenRouter FIRST when its key and
 * its own attestation are both in place (7-day report, docs/audit/2026-10-03-ai-call-success.md:
 * direct Gemini text capture 0/3, OpenRouter 96 %). Otherwise capture is the Gemini pair exactly
 * as before. Read live, like the coach's OpenRouter fallback, so a running process sees a change.
 */
export function captureOpenRouterReady(): boolean {
  return openRouterConfigured() && openRouterAttested();
}

/** OpenRouter's share of the one 20 s capture budget: one attempt, then Gemini gets the rest. */
const OPENROUTER_BUDGET_MS = 8_000;

/**
 * Gemini is a different provider on a different key, so an OpenRouter PROVIDER failure is worth
 * it: an HTTP error status, a capacity or quota answer, an open circuit, no answer in time, or the
 * connection itself failing. Anything else is ours and propagates (DeepSeek audit on #334): the
 * spend cap, a reply our schema refused, a refusal, a programming error — a second provider would
 * only mask it and bill twice.
 */
export function worthGemini(e: unknown): boolean {
  if (e instanceof HttpError || e instanceof SchemaRejection) return false;
  if (e instanceof ProviderHttpError || classifyFailure(e) === "timeout") return true;
  // undici's own network failure (DNS, reset, TLS): the provider could not be reached.
  if (e instanceof TypeError && e.message === "fetch failed") return true;
  return e instanceof Error && !e.message.startsWith("refused:") && isCapacityFailure(e);
}

function outOfTime(): Error {
  const err = new Error("the capture budget ran out before Gemini could be asked");
  err.name = "AbortError";
  return err;
}

function boundedError(e: unknown): { name: string; message: string } {
  return e instanceof Error
    ? { name: e.name, message: e.message.slice(0, 500) }
    : { name: "UnknownError", message: "non-Error rejection" };
}

/**
 * The payload comes from `capturePayload` (lib/ai/gemini-payloads.ts), which checked the Gemini
 * attestation. `openRouter`, when given, comes from `captureOpenRouterPayload`
 * (lib/ai/openrouter-payloads.ts), which checked OpenRouter's — and must be the same purpose's twin.
 */
export async function runCapture<P extends CapturePurpose>(
  payload: GeminiPayload<P>, ctx: CaptureCtx, deps: CaptureDeps = {}
): Promise<CaptureOutput[P]> {
  const purpose: P = payload.purpose;
  const prompt = PROMPTS[purpose];
  const startedAt = Date.now();
  let provider = "google" as "google" | "openrouter";
  let modelId: string = MODELS[purpose];
  const generate = (route: RouteOverride | undefined, timeoutMs: number | undefined) =>
    generateStructured({
      payload, userId: ctx.userId, admin: ctx.admin, schema: CAPTURE_SCHEMAS[purpose],
      maxOutputTokens: prompt.maxOutputTokens, route, timeoutMs, abandonOnCapacity: route === undefined && FALLBACK !== null,
      refuse: refusalFor(purpose),
    }, deps) as Promise<CaptureOutput[P]>;
  const openRouterTwin = ctx.openRouter ?? ctx.openRouterFallback;
  if (openRouterTwin && CAPTURE_TWIN[openRouterTwin.purpose] !== purpose) {
    // A caller bug, never a provider failure: no call is made and nothing falls back.
    console.error("capture refused a mismatched OpenRouter payload", {
      purpose, openRouterPurpose: openRouterTwin.purpose,
    });
    throw new HttpError(500, "internal", "Capture is unavailable right now.");
  }
  /** 2026-10-06: the fallback-only OpenRouter twin (voiceToItems today), tried once the Gemini
   *  pair below is exhausted. Returns null when there is no twin, it is not configured, or the
   *  failure that brought us here is not worth a different provider — the ORIGINAL error is what
   *  the caller sees then, never this helper's own "nothing to try" outcome. */
  const tryOpenRouterFallback = async (geminiError: unknown): Promise<CaptureOutput[P] | null> => {
    if (!ctx.openRouterFallback) return null;
    if (!(isPermissionDeniedFailure(geminiError) || providerFallbackWorthTrying(geminiError))) return null;
    const left = CAPTURE_BUDGET_MS - (Date.now() - startedAt);
    if (left < MIN_FALLBACK_MS) return null;
    const orModel = captureVoiceOpenRouterModel();
    console.warn("capture fell back to openrouter after gemini failed", {
      purpose, to: orModel, after: `${Date.now() - startedAt} ms`, error: boundedError(geminiError),
    });
    provider = "openrouter"; modelId = orModel;
    return await (deps.generateOpenRouter ?? generateOpenRouter)({
      payload: ctx.openRouterFallback, userId: ctx.userId, admin: ctx.admin, modelId: orModel,
      schema: CAPTURE_SCHEMAS[purpose], maxOutputTokens: prompt.maxOutputTokens,
      timeoutMs: left, attemptTimeoutMs: left, abandonOnCapacity: true,
      inputHash: ctx.inputHash, refuse: refusalFor(purpose),
    }, deps.openRouterDeps) as CaptureOutput[P];
  };
  try {
    if (ctx.openRouter) {
      const orModel = captureOpenRouterModel();
      try {
        return await (deps.generateOpenRouter ?? generateOpenRouter)({
          payload: ctx.openRouter, userId: ctx.userId, admin: ctx.admin, modelId: orModel,
          schema: CAPTURE_SCHEMAS[purpose], maxOutputTokens: prompt.maxOutputTokens,
          timeoutMs: OPENROUTER_BUDGET_MS, attemptTimeoutMs: OPENROUTER_BUDGET_MS,
          abandonOnCapacity: true, inputHash: ctx.inputHash, refuse: refusalFor(purpose),
        }, deps.openRouterDeps) as CaptureOutput[P];
      } catch (e) {
        if (!worthGemini(e)) { provider = "openrouter"; modelId = orModel; throw e; }
        // Never the prompt, the reply or the media: the bounded error only, as below.
        console.warn("capture fell back to gemini", {
          purpose, from: orModel, after: `${Date.now() - startedAt} ms`, error: boundedError(e),
        });
      }
    }
    // What is left of the one capture budget once OpenRouter has had its turn (all of it when
    // OpenRouter was not tried, so the Gemini pair behaves exactly as it always did).
    const left = CAPTURE_BUDGET_MS - (Date.now() - startedAt);
    if (left <= 0) throw outOfTime();
    if (!FALLBACK) {
      try {
        return await generate(undefined, ctx.openRouter ? left : undefined);
      } catch (e) {
        const fell = await tryOpenRouterFallback(e);
        if (fell !== null) return fell;
        throw e;
      }
    }
    const primaryMs = geminiPrimaryBudgetMs(left);
    if (primaryMs === null) {
      // No room for both Gemini models: the one that has been answering (lib/ai/lanes.ts) runs alone.
      modelId = FALLBACK;
      try {
        return await generate({ provider: "google", modelId: FALLBACK }, left);
      } catch (e) {
        const fell = await tryOpenRouterFallback(e);
        if (fell !== null) return fell;
        throw e;
      }
    }
    try {
      return await generate(undefined, primaryMs);
    } catch (e) {
      // 2026-10-06 (Sol review, BLOCK): giving the same-key Gemini backup the rest of the 20 s
      // budget could leave under its own MIN_FALLBACK_MS for OpenRouter afterwards on a SLOW
      // failure (a hang, not a fast 403) — the one provider left standing would starve for want
      // of a second same-key Gemini attempt. A purpose with another provider's fallback
      // (ctx.openRouterFallback, voice) skips the same-key backup outright, worth-checking or not
      // — a permission-denied primary makes it pointless anyway (lib/ai/failures.ts
      // worthFallback already says no to that one case), and a genuinely different, healthy
      // provider is worth more than a second Gemini model on the same key for any other failure.
      const budget = (!ctx.openRouterFallback && worthFallback(e))
        ? fallbackBudgetMs(Date.now() - startedAt) : null;
      if (budget === null) {
        const fell = await tryOpenRouterFallback(e);
        if (fell !== null) return fell;
        throw e;
      }
      modelId = FALLBACK;
      try {
        return await generate({ provider: "google", modelId: FALLBACK }, budget);
      } catch (e2) {
        const fell = await tryOpenRouterFallback(e2);
        if (fell !== null) return fell;
        throw e2;
      }
    }
  } catch (e) {
    // The spend cap already arrives as an HttpError; pass it through untouched.
    if (e instanceof HttpError) throw e;
    if (e instanceof SchemaRejection) {
      throw new HttpError(422, "schema_invalid", "The model returned a shape we do not accept.");
    }
    const message = e instanceof Error ? e.message : "";
    // Never log the prompt, response, or media. The bounded error metadata mirrors what
    // ac70ffd added for the coach path, so a capture-only provider outage is just as
    // diagnosable in server logs as a coach one.
    console.error("capture generation failed", {
      purpose,
      provider: provider === "openrouter" ? provider : modelProvider(modelId),
      modelId,
      error: boundedError(e),
    });
    if (message.startsWith("circuit open")) {
      throw new HttpError(503, "provider_unavailable", "Capture is unavailable right now.");
    }
    throw new HttpError(503, "provider_unavailable", "Capture did not answer. Try again.");
  }
}
