/**
 * Phase 13 §3.3, §9 R8 (slice 6): the `lookup` lane's own Gemini transport and entry point. Every
 * gate and the `ai_calls` row come from callModel (lib/ai/call.ts), as for every other lane; what
 * differs is the call itself: `googleSearch` grounding, no `responseSchema`, one attempt, and a
 * grounding line on the bill.
 */
import { GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertPinnedSdk, geminiHttpError, inputHashFor, installedGenai, resolveTarget, type RouteOverride,
} from "@/lib/ai/adapter";
import { callModel } from "@/lib/ai/call";
import { geminiProvenance } from "@/lib/ai/gemini-payloads";
import { geminiUsage } from "@/lib/ai/gemini-usage";
import { REJECTS_MINIMAL_THINKING } from "@/lib/ai/lanes";
import type { GroundingMetadata } from "@/lib/ai/lookup-grounding";
import { estimateCostUsd, inputTokensUpperBound, reserveCostUsd } from "@/lib/ai/models";
import type { GeminiPayload } from "@/lib/ai/payloads";
import { GROUNDING_QUERIES_RESERVED, groundingCostUsd } from "@/lib/ai/spend";

export type GroundedProviderResult = {
  text: string; groundingMetadata: GroundingMetadata; inputTokens: number; outputTokens: number;
};

/**
 * The lookup lane's own transport — `googleSearch` grounding, no `responseSchema` (the provider
 * does not accept controlled generation and a search tool on the same call). One attempt, no retry
 * loop: `generateGrounded` bounds it with the lane's own 8 s budget (lib/ai/lanes.ts
 * LANES.lookup.budgetMs), not the structured-call retry policy.
 */
async function geminiGroundedCall(
  model: string, parts: Part[], signal?: AbortSignal, temperature: number = 0,
): Promise<GroundedProviderResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: key });
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        temperature,
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: REJECTS_MINIMAL_THINKING.has(model)
          ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL },
        ...(signal === undefined ? {} : { abortSignal: signal }),
      },
    });
    const { inputTokens, outputTokens } = geminiUsage(res.usageMetadata);
    return {
      text: res.text ?? "",
      groundingMetadata: (res.candidates?.[0]?.groundingMetadata ?? null) as GroundingMetadata,
      inputTokens, outputTokens,
    };
  } catch (e) {
    throw geminiHttpError(e) ?? e;
  }
}

export type GroundedArgs = {
  /** Only `lookupPayload`'s output reaches this: the `lookup` purpose is Gemini's only grounded
   *  call site (lib/ai/call-registry.ts). */
  payload: GeminiPayload<"lookup">;
  userId: string; admin: SupabaseClient;
  /** The lane's own budget (LANES.lookup.budgetMs, §9 R8); no default here, so a caller never
   *  silently inherits the structured-call default. */
  timeoutMs: number;
  temperature?: number;
  route?: RouteOverride;
  /**
   * The coach turn's own abort (lib/server/coach-turn.ts `turnAbort`), fired when the tool batch
   * stops waiting. It cancels the provider call on the spot, so the hop never outlives the batch's
   * bound — and so never runs past `replyDeadlineAt` — whatever is left of its 8 s (review r1).
   */
  signal?: AbortSignal;
};
export type GroundedResult = GroundedProviderResult & {
  /** `groundingMetadata.webSearchQueries.length` — the count `groundingCostUsd` was billed on. */
  webSearchQueries: number;
};
/** A turn abort, as the AbortError `classifyFailure` reads as a timeout. */
function turnAborted(): Error {
  const err = new Error("the coach turn stopped waiting for the lookup");
  err.name = "AbortError";
  return err;
}

export type GroundedDeps = {
  callGeminiGrounded?: (model: string, parts: Part[], signal?: AbortSignal, temperature?: number)
    => Promise<GroundedProviderResult>;
};

/**
 * The `lookup` lane's own entry point (§3.3, §9 R8): one ungrounded-schema Gemini call with
 * `googleSearch`, under the spend cap and circuit breaker every other purpose uses, billed at
 * token price PLUS `webSearchQueries.length x $0.014` (§8 item 3, lib/ai/spend.ts). Unlike
 * `generateStructured` there is no retry loop — a stalled search is worth a clean refusal inside
 * the lane's own budget, not a second attempt that risks the coach turn's wall clock (§9 R8
 * "honest latency").
 */
export async function generateGrounded(
  args: GroundedArgs, deps: GroundedDeps = {},
): Promise<GroundedResult> {
  assertPinnedSdk();
  const { payload } = args;
  const queries = (result: GroundedProviderResult): number =>
    result.groundingMetadata?.webSearchQueries?.length ?? 0;
  return callModel({
    payload, provenance: geminiProvenance,
    target: () => ({ ...resolveTarget(payload.purpose, args.route), sdkVersion: installedGenai().version }),
    ledger: () => ({ userId: args.userId, admin: args.admin }),
    inputHash: () => inputHashFor(payload.parts),
    signal: args.signal, abortError: turnAborted,
    policy: { attempts: 1, budgetMs: args.timeoutMs, attemptMs: args.timeoutMs, backoffMs: [],
      retryable: () => false },
    transport: {
      send: (signal, model) => (deps.callGeminiGrounded ?? geminiGroundedCall)(
        model, [...payload.parts], signal, args.temperature ?? 0),
    },
    accept: (result) => ({ ...result, webSearchQueries: queries(result) }),
    price: (model, billed) => estimateCostUsd(model, billed.inputTokens, billed.outputTokens),
    surchargeUsd: (result) => groundingCostUsd(queries(result)),
    // Tokens at their bound (no output cap is set) plus the reserved search-query ceiling.
    maxAttemptCostUsd: (model) => reserveCostUsd(model,
      inputTokensUpperBound(payload.parts.map((p) => p.text ?? ""))) + groundingCostUsd(GROUNDING_QUERIES_RESERVED),
  });
}
