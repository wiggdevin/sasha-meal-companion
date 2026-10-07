/**
 * Phase 13 §3 (slice 1): the one lane table. Every pinned model id in the app lives here, as a
 * LITERAL: an env-var-driven id, or a "latest" alias the app does not control, would make a silent
 * provider change indistinguishable from a deploy. lib/ai/models.ts reads its
 * pins from this table; tests/ai/lanes.test.ts guards app/, lib/, components/ and scripts/
 * (except the price table in lib/ai/models.ts).
 *
 * A lane's pin changes only through a PR that attaches a lane-bench report (§3.2,
 * scripts/eval/lane-bench.ts). DECIDED (run): a model takes a lane when it is at least as accurate
 * and faster, or clearly more accurate within the lane's latency budget.
 *
 * Slice 1 changed no behaviour, declaring the `lookup` lane without wiring it; slice 6 wires it.
 * The DeepSeek `ui` lane (slice 5) was removed on 2026-10-01: it recorded no production call in 30
 * days, and the comparison card it composed is drawn in code (lib/coach/blocks/hydrate-comparison.ts).
 *
 * Disclosed exception (GPT-6 Sol review round 1): 14632dc's `geminiCall` fix
 * (lib/ai/adapter.ts) adds `usageMetadata.thoughtsTokenCount` into `outputTokens`, which raises
 * `ai_calls.cost_estimate` — and so the spend the caps settle (`reserveSpend`/`settleSpend`) — for every
 * production Gemini caller (coach, capture, weeklyReview). This is deliberate: it corrects a
 * pre-existing undercount (thinking tokens were always billed by the provider; they were simply
 * never counted here), not a lane or pin change, and it is covered end to end, including against
 * the spend cap itself, in lib/ai/adapter.gemini-usage.test.ts.
 */
import { CLEARED, type CallProvider, type DataClass } from "@/lib/ai/call-registry";

export type LaneName =
  | "route" | "mechanical" | "converse" | "capture" | "plan" | "lookup" | "judge";

export type Lane = {
  /** What the lane does, in one line. */
  job: string;
  /** null for the mechanical lane: no model at all. */
  provider: CallProvider | null;
  model: string | null;
  /**
   * What answers when the pinned model cannot: another model id, a named non-model path, or null
   * (the caller's own degrade path, e.g. Jev failures fall through).
   */
  fallback: string | null;
  /** The lane's own deadline in ms, or null when the caller's budget governs (see `budgetNote`). */
  budgetMs: number | null;
  budgetNote: string;
  /** Whether a live runtime path uses the lane today. */
  wired: boolean;
};

export const LANES = {
  route: {
    job: "classify the coach turn (intent pre-pass)",
    provider: "typesafe", model: "jev-latest", fallback: null,
    budgetMs: 3_000, budgetNote: "lib/coach/intent.ts deadlineMs", wired: true,
  },
  mechanical: {
    job: "fast-path actions and deterministic blocks",
    provider: null, model: null, fallback: null,
    budgetMs: null, budgetNote: "no model call", wired: true,
  },
  converse: {
    job: "the coach tool loop",
    // Coach-only capacity pin: 3.8 and 3.7 both returned 503 after their retry budgets during the
    // 2026-09-13 production canary; 3.6 passed the same structured-output probe on the paid project.
    provider: "google", model: "gemini-3.6-flash",
    // The one model a turn may fall back to on capacity (T6 §5): the capture pin, same provider,
    // same key, same schema support.
    fallback: "gemini-3.8-flash",
    budgetMs: null, budgetNote: "the coach turn wall clock (lib/coach/turn.ts TURN_LIMITS)",
    wired: true,
  },
  capture: {
    job: "photo, voice, label and text to items",
    // 2026-10-02: 3.8 answered 503 under demand for hours while 3.6 answered in a second on the
    // same key — the coach's pair, the other way round (lib/ai/capture.ts runCapture).
    provider: "google", model: "gemini-3.8-flash", fallback: "gemini-3.6-flash",
    budgetMs: null, budgetNote: "lib/ai/adapter.ts DEFAULT_CALL_TIMEOUT_MS", wired: true,
  },
  plan: {
    job: "read a Plan photo or document",
    provider: "openrouter", model: "google/gemini-3-flash-preview", fallback: "gemini-3.8-flash",
    budgetMs: null, budgetNote: "the Plan reader's per-request budget", wired: true,
  },
  lookup: {
    job: "web-grounded food and nutrition facts (§3.3)",
    provider: "google", model: "gemini-3.8-flash", fallback: null,
    budgetMs: 8_000, budgetNote: "a sequential tool hop inside the coach budget (§9 R8)",
    // Slice 6: the coach tool, subject validator/resolver and grounding-support filter are wired
    // (lib/server/lookup-lane.ts). The pin itself is unchanged from slice 1.
    wired: true,
  },
  judge: {
    job: "facets, safety, sanity, ranking",
    provider: "typesafe", model: "jev-latest", fallback: null,
    budgetMs: 3_000, budgetNote: "each caller's deadlineMs; lib/coach/suggest.ts may pass up to its remaining turn budget, and lib/ai/typesafe.ts bounds the request, not the body read", wired: true,
  },
} as const satisfies Record<LaneName, Lane>;

/**
 * OpenRouter model ids share the lane table's PR-controlled pin policy. The Plan readers' pins are
 * the `plan` lane's primary model, so the lane and these pins cannot drift apart.
 */
export const OPENROUTER_PINS = {
  coach: "google/gemini-2.5-flash",
  coachFallback: "google/gemini-3-flash-preview",
  planPhoto: LANES.plan.model,
  planDocument: LANES.plan.model,
  capture: "google/gemini-2.5-flash",
  /** Onboarding v2's extraction call asks this model first (lib/server/onboarding-extract.ts),
   *  same pin as capture: a small bounded-schema read, not a conversation. */
  onboardingExtract: "google/gemini-2.5-flash",
  /**
   * 2026-10-06 (Gemini project denial, #gemini-fallback): the audio-capable model voice capture
   * and the coach's transcribe fallback use once Gemini itself fails. The SAME slug already pinned
   * for text/photo/label capture (`capture` above), not a new, separately-vetted model: the Gemini
   * family takes native audio input, not vision alone, and this slug already carries a 7-day
   * production track record (docs/audit/2026-10-03-ai-call-success.md) and cleared OpenRouter
   * attestation. A model id is a LITERAL here like every other pin in this table (module comment)
   * — never env-driven — so "configurable by env" for this fallback means WHETHER it runs at all
   * (OPENROUTER_API_KEY + OPENROUTER_ATTESTED, the same gate lib/ai/capture.ts
   * captureOpenRouterReady already uses), not which model answers.
   */
  captureVoice: "google/gemini-2.5-flash",
} as const;

/** The data classes a lane may carry: exactly its provider's clearance (spec §2). */
export function laneCleared(name: LaneName): readonly DataClass[] {
  const provider = (LANES[name] as Lane).provider;
  return provider === null ? [] : CLEARED[provider];
}

/**
 * Model properties that are not lanes. These models reject thinkingLevel MINIMAL, so
 * lib/ai/gemini-config.ts sends them LOW: gemini-3.8-flash (verified 2026-09-15) and
 * gemini-3.7-flash (the 2026-09-23 lane bench got 400 "Thinking level MINIMAL is not supported").
 */
export const REJECTS_MINIMAL_THINKING: ReadonlySet<string> =
  new Set(["gemini-3.8-flash", "gemini-3.7-flash"]);
