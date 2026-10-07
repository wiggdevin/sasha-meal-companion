import { openRouterAttested } from "@/lib/ai/attestation";
import { LANES, OPENROUTER_PINS } from "@/lib/ai/lanes";
import { openRouterConfigured } from "@/lib/ai/provider-env";

/**
 * The pinned model ids, the purposes that use them, and their prices. Split out of
 * lib/ai/adapter.ts (T4): the adapter re-exports all of this, every existing import keeps
 * working, and the adapter stays under the 400-line limit.
 *
 * Model ids are LITERALS. An env-var-driven id, or a "latest" alias, would make a silent
 * provider change indistinguishable from a deploy, which is exactly what the pin prevents.
 */

/**
 * The pinned models come from the lane table (lib/ai/lanes.ts, Phase 13 §3), which holds every
 * model id literal. These names are kept so every existing import still works.
 */

/** The capture lane's pin (Phase 0, T4). */
export const GEMINI_FLASH = LANES.capture.model;

/** The converse lane's pin: the coach-only capacity pin, selected in code, never by env. */
export const GEMINI_COACH = LANES.converse.model;

/**
 * Owner request 2026-10-02 ("can we use open router?"): which provider answers the coach's
 * PRIMARY turn. "google" (unset, or anything but "openrouter") keeps today's pinned Gemini lane
 * exactly as it was. "openrouter" sends the turn through lib/ai/openrouter.ts instead, at
 * the OpenRouter coach pin — gated at call time by that provider's own configuration and attestation
 * (lib/ai/provider-env.ts, lib/ai/attestation.ts), same as every other D2 lane.
 */
/**
 * The coach uses OpenRouter only when the provider switch, key and attestation are all ready.
 * Otherwise it warns once at module load and uses the Gemini pin. The key and attestation names
 * stay in provider-env.ts and attestation.ts (tests/ai/call-registry.test.ts).
 */
const wantsOpenRouter = process.env.COACH_PROVIDER === "openrouter";
const openRouterReady =
  wantsOpenRouter && openRouterConfigured() && openRouterAttested();
if (wantsOpenRouter && !openRouterReady) {
  console.warn("[lib/ai/models] COACH_PROVIDER=openrouter is not ready (needs the OpenRouter"
    + " key and its attestation) — falling back to the Gemini pin instead of"
    + " sending turns to OpenRouter's catalog.");
}

export const COACH_PROVIDER: "google" | "openrouter" = openRouterReady ? "openrouter" : "google";

/**
 * The coach's pinned model, exported for the persisted `coach_messages.model_id`.
 *
 * Both providers' pins live in lib/ai/lanes.ts. Default (COACH_PROVIDER unset) is
 * byte-identical to the Gemini pin it always was.
 */
export const COACH_MODEL_ID: string =
  COACH_PROVIDER === "openrouter" ? OPENROUTER_PINS.coach : GEMINI_COACH;

/**
 * The one model a coach turn may fall back to when the pinned one has spent its whole retry
 * budget on 503s (T6 §5). It is the CAPTURE model: same provider, same key, same schema support,
 * already priced below, and already exercised on every photo and label. The circuit breaker is
 * per MODEL (2026-10-02), so an open circuit on the pinned model still leaves this one to try; a
 * provider that is fully down fails both, and the turn says so.
 */
export const COACH_FALLBACK_MODEL_ID = LANES.converse.fallback;

/**
 * Owner request 2026-10-02 (T8): the one OpenRouter model a coach turn may retry on once every
 * Gemini option (the pin above, then its same-key fallback) is out of capacity — or, for a
 * key-quota 429, in place of the same-key fallback entirely, since a second Gemini model meets
 * the same quota wall (lib/ai/failures.ts worthAnotherModel) but OpenRouter is a different key.
 * The pin is always available; lib/server/coach-turn/model-loop.ts checks the OpenRouter key
 * and attestation before using it.
 */
export function coachOpenRouterFallbackModel(): string {
  return OPENROUTER_PINS.coachFallback;
}

/** Every model id the coach turn should route to lib/ai/openrouter.ts instead of the Gemini
 *  adapter: the primary pin when COACH_PROVIDER=openrouter, and the capacity fallback when set. */
export function isOpenRouterModelId(modelId: string): boolean {
  return (COACH_PROVIDER === "openrouter" && modelId === COACH_MODEL_ID)
    || modelId === coachOpenRouterFallbackModel();
}

/**
 * Owner request 2026-10-02 ("for Google Gemini we should be using OpenRouter now"): the OpenRouter
 * model that reads plan-sheet photos, pinned in lib/ai/lanes.ts (the Plan lane's primary; its Gemini
 * twin is LANES.plan.fallback).
 */
export function planPhotoModel(): string {
  return OPENROUTER_PINS.planPhoto;
}

/** The Plan panel's document reader (`documentToPlan`), which reads images and PDFs natively. */
export function planDocumentModel(): string {
  return OPENROUTER_PINS.planDocument;
}

/**
 * Owner request 2026-10-02 ("Gemini calls go through OpenRouter"): the OpenRouter model that
 * answers text, photo and label capture FIRST (lib/ai/capture.ts runCapture), with the pinned
 * Gemini lane kept as the fallback. Like the coach and plan photo pins, it changes through the
 * lane table. The pin is the slug the 7-day
 * ai_calls report (docs/audit/2026-10-03-ai-call-success.md) measured at 96 % ok, p50 2.4 s.
 */
export function captureOpenRouterModel(): string {
  return OPENROUTER_PINS.capture;
}

/** The OpenRouter model onboarding's extraction call asks first (lib/ai/lanes.ts). */
export function onboardingExtractOpenRouterModel(): string {
  return OPENROUTER_PINS.onboardingExtract;
}

/**
 * 2026-10-06 (Gemini project denial): the OpenRouter model voice capture (`voiceToItems`) and the
 * coach's transcribe route (lib/server/coach-transcribe.ts) fall back to once Gemini itself fails.
 * Gemini stays PRIMARY for both — this is the fallback, not a flip like the three purposes above.
 */
export function captureVoiceOpenRouterModel(): string {
  return OPENROUTER_PINS.captureVoice;
}

/** TypeSafe's Jev model alias, shared by the route and judge lanes. */
export const JEV_MODEL = LANES.judge.model;

export const MODELS = {
  textToItems: GEMINI_FLASH,
  voiceToItems: GEMINI_FLASH,
  labelToNutrients: GEMINI_FLASH,
  photoToItems: GEMINI_FLASH,
  // The coach passes its model in (it may fall back once, T6 §5); the weekly review uses this
  // entry as it stands.
  coach: GEMINI_COACH,
  weeklyReview: GEMINI_COACH,
  /**
   * T7 §2: the coach's voice fallback transcribes a clip on the CAPTURE pin, not the coach pin —
   * it is the same job the voice capture path already does with audio, and the key is the purpose
   * `ai_calls` records. The hyphen is deliberate: the row reads `coach-transcribe`.
   */
  "coach-transcribe": GEMINI_FLASH,
  "photoToIdeas-gemini": LANES.plan.fallback,
  "documentToPlan-gemini": LANES.plan.fallback,
  /** Phase 13 §3.3 (slice 6): the lookup lane's pin, unchanged from slice 1. */
  lookup: LANES.lookup.model,
  /** Onboarding v2's extraction call: the capture pin — a cheap, fast flash model, exactly what
   *  a small bounded-schema extraction needs, already priced below. The Gemini fallback leg,
   *  not the primary leg (lib/server/onboarding-extract.ts asks OpenRouter first). */
  "onboarding-extract": GEMINI_FLASH,
} as const;

export type Purpose = keyof typeof MODELS;

/**
 * USD per 1,000,000 tokens, input and output priced separately. Feeds
 * AI_DAILY_SPEND_CAP_USD, which is a brake on a runaway loop, not an invoice.
 *
 * Standard paid-tier prices verified against ai.google.dev on 2026-09-13.
 */
export const PRICE_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  // Lane-bench candidate only (§3.2 capture: 3.8 vs 3.7); ai.google.dev pricing, read 2026-09-23.
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  // A model with no price silently costing $1/M would make the spend cap lie about a model
  // nobody priced. Every id in MODELS must be in the table.
  const price = PRICE_PER_MILLION_TOKENS[model];
  if (!price) throw new Error(`no price is recorded for model '${model}'`);
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/** The most a Gemini Flash reply can emit (thinking included) when a call sets no output cap. */
export const MAX_OUTPUT_TOKENS_CEILING = 65_536;
/** Tokens one media part can take at most (an image's tiles, 30 s of audio, a short PDF). */
export const MEDIA_TOKENS_CEILING = 16_384;
/** The request's own framing: role markers, the response schema, the system instruction. */
const PROMPT_OVERHEAD_TOKENS = 4_096;

/**
 * An upper bound on a request's input tokens: one token per UTF-8 byte of text (a token always
 * covers at least one byte), plus the media ceiling per media part and the framing overhead.
 */
export function inputTokensUpperBound(texts: readonly string[], mediaParts = 0): number {
  const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  return bytes + mediaParts * MEDIA_TOKENS_CEILING + PROMPT_OVERHEAD_TOKENS;
}

/**
 * The most one Gemini attempt can cost (scale S2, lib/ai/spend.ts): its input bound and its own
 * output cap (the model's ceiling when unset) at the model's price. The settle records the real
 * usage; the bounded overshoot is any reply that beats this bound.
 */
export function reserveCostUsd(model: string, inputTokens: number,
  maxOutputTokens = MAX_OUTPUT_TOKENS_CEILING): number {
  return estimateCostUsd(model, inputTokens, maxOutputTokens);
}

/**
 * The provider each pinned model belongs to — the runtime half of the pin. Gemini is the only
 * provider the adapter calls, so any other id has none and the adapter refuses it.
 */
export function modelProvider(model: string): "google" | null {
  return model.startsWith("gemini-") ? "google" : null;
}
