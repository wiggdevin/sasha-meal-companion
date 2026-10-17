/**
 * Phase 13 §2 (slice 0): every model-call purpose, the provider it reaches, the data class it
 * sends and the one payload builder that mints its requests. callModel (lib/ai/call.ts) looks the
 * purpose up at runtime and refuses a purpose that is not registered, is registered for another
 * provider, or sends a class that provider is not cleared for. tests/ai/call-registry.test.ts
 * checks the table and the provider boundary (no provider SDK, host or key outside lib/ai).
 *
 * Data classes (spec §2):
 *   D0 food-only: a food name, its ingredients, a generic nutrition question with no user facts.
 *   D1 user nutrition and behaviour: meals, targets, weight, preference text, the user's messages.
 *   D2 health context held as a user fact: conditions, allergies, clinician directives, medicines.
 *
 * A call site declares the HIGHEST class its payload can carry. Free text or audio from the user
 * may carry incidental D2 (spec §2, "Incidental D2"); it is declared D2 when it goes to Gemini. The
 * Jev paths that carry the user's own words are D1: incidental D2 there is the residual the owner
 * accepted on 2026-09-23 ("not too guarded"). OD12's gate (lib/ai/jev-health.ts, `JEV_HEALTH_GATE=1`,
 * off for in-house testing) keeps free text the local check does not clear, and every coach reply,
 * off Jev.
 */

export type DataClass = "D0" | "D1" | "D2";
export type CallProvider = "google" | "typesafe" | "openrouter";

/**
 * Spec §2 "Cleared classes per provider". The retired providers (Nous Portal, rejected 2026-09-12,
 * docs/ai-data-handling.md; DeepSeek, removed 2026-10-01) are not providers here at all.
 *
 * `openrouter` (owner request 2026-10-02, docs/ai-data-handling.md) is cleared the same as
 * `google`: it is the coach's capacity fallback and, with `COACH_PROVIDER=openrouter`, its primary
 * — both carry the same D2 turn content Gemini does — gated by its own attestation pair
 * (lib/ai/attestation.ts), never by this clearance alone.
 */
export const CLEARED: Readonly<Record<CallProvider, readonly DataClass[]>> = {
  google: ["D0", "D1", "D2"],
  typesafe: ["D0", "D1"],
  openrouter: ["D0", "D1", "D2"],
};

export type CallSite = {
  provider: CallProvider;
  dataClass: DataClass;
  /** The one payload builder (lib/ai/payloads.ts, lib/ai/gemini-payloads.ts) for this purpose. */
  builder: string;
};

/**
 * OD01: purposes no person waits on — the weekly review (a cron) and facet warming. Their spend
 * reservations count against the background ceiling and never use an account's interactive
 * reserve (lib/ai/spend.ts `reserveSpend`). Every other purpose is interactive.
 */
export const BACKGROUND_PURPOSES: ReadonlySet<string> =
  new Set(["weeklyReview", "food_facets"] satisfies RegisteredPurpose[]);

export const CALL_REGISTRY = {
  // ---- Jev (TypeSafe System One) --------------------------------------------------------------
  "coach-intent": { provider: "typesafe", dataClass: "D1", builder: "intentPayload" },
  "profile-prefs": { provider: "typesafe", dataClass: "D1", builder: "prefsPayload" },
  // Phase 18 W5b (D9 item 3): the free taste text, only after the local safety check sent it (the
  // builder re-runs the check), plus the food families it names. No profile, rule or stored taste.
  "profile-taste": { provider: "typesafe", dataClass: "D1", builder: "tastePayload" },
  // The reply Jev checks can echo the user's stored conditions from the coach prompt. That is the
  // incidental-D2 residual spec §8 item 1 records as open (TypeSafe terms question); the lane
  // stays D1 until that answer lands, on the owner's ruling, not by oversight.
  "coach-verify": { provider: "typesafe", dataClass: "D1", builder: "verifyPayload" },
  "suggest-options": { provider: "typesafe", dataClass: "D1", builder: "suggestPayload" },
  "meal-component-role": { provider: "typesafe", dataClass: "D1", builder: "rolePayload" },
  log_sanity: { provider: "typesafe", dataClass: "D1", builder: "sanityPayload" },
  food_facets: { provider: "typesafe", dataClass: "D1", builder: "facetPayload" },
  jev_facets_eval: { provider: "typesafe", dataClass: "D0", builder: "facetEvalPayload" },
  // Phase 17 O3: the occasion-rubric calibration eval (scripts/eval/facets-occasion-eval.ts), on a
  // labelled synthetic holdout of foods and dishes. Food-only, no user: D0. Never runs in CI.
  jev_occasion_eval: { provider: "typesafe", dataClass: "D0", builder: "occasionEvalPayload" },
  // W142: the check before "Day fully logged". Counts and clock hours about the viewed day only
  // (lib/day-completeness.ts): no food name, note, profile or health field. Advisory; never blocks.
  day_completeness: { provider: "typesafe", dataClass: "D1", builder: "dayCompletenessPayload" },
  // Phase 18 W1c (D9 item 2): offline pair-plausibility labels for the pairing table
  // (scripts/pairing/jev-labels.ts). Catalog food names and a stated occasion only: D0. Never on a
  // request path, never in CI.
  pair_plausibility: { provider: "typesafe", dataClass: "D0", builder: "pairPlausibilityPayload" },
  // ---- Gemini (paid, attested project) --------------------------------------------------------
  // The ordinary turn and source-bound saved-chat synthesis both use this attested payload lane.
  coach: { provider: "google", dataClass: "D2", builder: "coachTurnPayload" },
  weeklyReview: { provider: "google", dataClass: "D1", builder: "weeklyReviewPayload" },
  "coach-transcribe": { provider: "google", dataClass: "D2", builder: "transcribePayload" },
  "photoToIdeas-gemini": { provider: "google", dataClass: "D1", builder: "inspirePhotoGeminiPayload" },
  "documentToPlan-gemini": { provider: "google", dataClass: "D2", builder: "documentPlanGeminiPayload" },
  textToItems: { provider: "google", dataClass: "D2", builder: "capturePayload" },
  voiceToItems: { provider: "google", dataClass: "D2", builder: "capturePayload" },
  labelToNutrients: { provider: "google", dataClass: "D1", builder: "capturePayload" },
  photoToItems: { provider: "google", dataClass: "D1", builder: "capturePayload" },
  // ---- Gemini (lookup lane; slice 6) -----------------------------------------------------------
  lookup: { provider: "google", dataClass: "D1", builder: "lookupPayload" },
  // Onboarding v2 (BRIEF.md §5): the one bounded extraction call on the opener — goal, activity,
  // cooking effort and diet-preference words only. D1, never D2: the local safety guard
  // (lib/coach/onboarding-safety.ts) refuses to build either purpose's payload from text it has
  // not already cleared, so this call never carries allergy/medical content. A standing privacy
  // rule (tests/ai/no-demographics-payload.test.ts) keeps every other demographic field out of
  // this purpose entirely — read by the account's own regex reader before anything is sent here.
  "onboarding-extract": { provider: "google", dataClass: "D1", builder: "onboardingExtractPayload" },
  // ---- OpenRouter (owner request 2026-10-02): the coach's capacity fallback, and its primary
  // when COACH_PROVIDER=openrouter. Separate purpose from `coach` so callRefusal's provider check
  // (site.provider !== provider) still refuses a payload minted for one reaching the other.
  "coach-openrouter": { provider: "openrouter", dataClass: "D2", builder: "coachOpenRouterPayload" },
  // The plan sheet's "snap your fridge or a recipe": one photo in, food names out (no planning).
  photoToIdeas: { provider: "openrouter", dataClass: "D1", builder: "inspirePhotoPayload" },
  // The plan sheet's "+": one meal plan, recipe or menu (photo, PDF or text) read into data. D2: a
  // plan from a dietitian can carry clinician directives.
  documentToPlan: { provider: "openrouter", dataClass: "D2", builder: "documentPlanPayload" },
  // Owner request 2026-10-02: text, photo and label capture go to OpenRouter first, the Gemini
  // twins above stay as the fallback (lib/ai/capture.ts). Each carries the SAME class as its
  // Gemini twin.
  "textToItems-openrouter": { provider: "openrouter", dataClass: "D2", builder: "captureOpenRouterPayload" },
  "photoToItems-openrouter": { provider: "openrouter", dataClass: "D1", builder: "captureOpenRouterPayload" },
  "labelToNutrients-openrouter": { provider: "openrouter", dataClass: "D1", builder: "captureOpenRouterPayload" },
  // Onboarding v2's extraction call asks OpenRouter first, same as text/photo/label capture
  // (owner request 2026-10-02) — and, unrelated to that routing choice, is also the call's one
  // way to stay healthy while Gemini returns 403 project-denied in production (a separate fix
  // lands the general fallback; this purpose was never hard-wired to Gemini in the first place).
  "onboarding-extract-openrouter": {
    provider: "openrouter", dataClass: "D1", builder: "onboardingExtractOpenRouterPayload",
  },
  // 2026-10-06 (Gemini project denial): voice capture and the coach's transcribe fallback both get
  // an OpenRouter twin. Gemini stays PRIMARY for both (lib/ai/capture.ts, lib/server/coach-
  // transcribe.ts) — OpenRouter only answers once Gemini itself fails and the project is attested,
  // so the app recovers onto Gemini on its own the moment Google restores access.
  "voiceToItems-openrouter": { provider: "openrouter", dataClass: "D2", builder: "captureOpenRouterPayload" },
  "coach-transcribe-openrouter": { provider: "openrouter", dataClass: "D2", builder: "transcribeOpenRouterPayload" },
} as const satisfies Record<string, CallSite>;

export type RegisteredPurpose = keyof typeof CALL_REGISTRY;
export type PurposeOf<P extends CallProvider> = {
  [K in RegisteredPurpose]: (typeof CALL_REGISTRY)[K]["provider"] extends P ? K : never
}[RegisteredPurpose];

export function isCleared(provider: CallProvider, dataClass: DataClass): boolean {
  return CLEARED[provider].includes(dataClass);
}

/** Why a call is refused before anything is serialised, or null when it may proceed. */
export function callRefusal(
  purpose: string,
  provider: CallProvider,
  registry: Readonly<Record<string, CallSite>> = CALL_REGISTRY,
  cleared: Readonly<Record<CallProvider, readonly DataClass[]>> = CLEARED,
): string | null {
  const site = Object.hasOwn(registry, purpose) ? registry[purpose] : undefined;
  if (!site) return `purpose '${purpose}' is not in the call registry`;
  if (site.provider !== provider) {
    return `purpose '${purpose}' is registered for ${site.provider}, not ${provider}`;
  }
  if (!cleared[provider].includes(site.dataClass)) {
    return `${provider} is not cleared for ${site.dataClass} (purpose '${purpose}')`;
  }
  return null;
}
