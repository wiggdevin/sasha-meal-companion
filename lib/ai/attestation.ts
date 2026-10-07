/**
 * Phase 13 §2 "Gemini gate" and §9 R3: the project attestation that every Gemini call carrying user
 * content needs — the coach, the weekly review, transcription and all four capture purposes. Its two
 * halves are the reviewer's R4 switch (2026-09-12): `HEALTH_CONTEXT_PROVIDER=gemini` and
 * `GEMINI_BILLING_ATTESTED=1`, both manual, never inferred. It is checked for every user-content
 * call, not only when the stored profile holds a condition: user text, audio and photos can carry
 * health context whatever the profile says.
 *
 * It is checked in the payload builders (lib/ai/payloads.ts) before anything is serialised, and
 * again in callModel (lib/ai/call.ts) before a media upload. Production sets both variables.
 * With either one off, the call refuses with `503 nous_unconfirmed`.
 */
import { isOpenRouterModelId } from "@/lib/ai/models";
import { HttpError } from "@/lib/server/auth";

/**
 * The wire error code of every attestation refusal. The name predates the Nous Portal's retirement
 * (docs/ai-data-handling.md); clients and tests already read it, so it stays as it is.
 */
export const ATTESTATION_REFUSED_CODE = "nous_unconfirmed";

/** `HEALTH_CONTEXT_PROVIDER=gemini` and `GEMINI_BILLING_ATTESTED=1`, both manual, never inferred. */
export function geminiAttested(): boolean {
  return process.env.HEALTH_CONTEXT_PROVIDER === "gemini"
    && process.env.GEMINI_BILLING_ATTESTED === "1";
}

export class AttestationRefused extends HttpError {
  constructor() {
    super(503, ATTESTATION_REFUSED_CODE,
      "Your messages and photos cannot reach the model until the provider's data terms are recorded.");
  }
}

export function assertGeminiAttested(): void {
  if (!geminiAttested()) throw new AttestationRefused();
}

/**
 * Owner request 2026-10-02: the OpenRouter pair, mirroring Gemini's `HEALTH_CONTEXT_PROVIDER` +
 * `GEMINI_BILLING_ATTESTED` above. OpenRouter forwards every request to a THIRD party (whichever
 * model the slug names, not Anthropic or Google directly), so its own data-handling terms need
 * the same manual, never-inferred sign-off before a D1/D2 call can carry user content through it.
 * D0 (food-only) is exempt, same as Gemini's gate.
 */
export function openRouterAttested(): boolean {
  return process.env.OPENROUTER_ATTESTED === "1";
}

export function assertOpenRouterAttested(): void {
  if (!openRouterAttested()) throw new AttestationRefused();
}

/** A stored profile carries health context when it has a condition or a note. */
export function carriesHealthContext(
  profile: { conditions: string[]; notes: string | null },
): boolean {
  return profile.conditions.length > 0 || (profile.notes ?? "").length > 0;
}

/**
 * The coach's health-context gate: a turn whose stored profile carries health context is refused
 * outright — before the Jev fast path or any model call — unless the project is attested.
 *
 * 2026-10-02 DeepSeek audit: this read the Gemini pair alone, so a coach turn running under
 * COACH_PROVIDER=openrouter (lib/ai/models.ts) was refused even with OPENROUTER_ATTESTED=1 and no
 * Gemini pair set at all. `modelId` is optional and defaults to the old Gemini-only check — every
 * caller that does not pass one (the capture pipeline) keeps today's behaviour byte-identical; a
 * coach call site passes the model the turn is actually about to call (COACH_MODEL_ID) so the gate
 * asks the right provider's attestation, the same isOpenRouterModelId rule reply.ts already uses.
 */
export function healthContextRefused(
  profile: { conditions: string[]; notes: string | null },
  modelId?: string,
): boolean {
  if (!carriesHealthContext(profile)) return false;
  return modelId !== undefined && isOpenRouterModelId(modelId)
    ? !openRouterAttested() : !geminiAttested();
}
