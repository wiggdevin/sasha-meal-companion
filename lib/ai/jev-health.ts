/**
 * OD12 (docs/decisions/2026-10-12-owner-decisions.md): the fail-closed gate for health-bearing Jev
 * payloads. TypeSafe has not confirmed in writing that health text is allowed under its terms or a
 * zero-retention DPA, so until the owner records that and sets `JEV_HEALTH_ATTESTED=1` (manual,
 * never inferred, the same kind of switch as the Gemini and OpenRouter pairs in
 * lib/ai/attestation.ts), no text that may carry health context reaches Jev.
 *
 * "May carry health context" is decided the conservative way round: free text is clean only when
 * the W5b local check clears it (`mayReachJev`: plain likes and dislikes built from known words, or
 * a message that is wholly one app command). Anything the check does not clear counts as health
 * text, so a mistake can only keep plain text local, never send health text out.
 *
 * The payload builders (lib/ai/payloads.ts) use `jevTextCleared` to drop or mark free text, and the
 * TypeSafe adapter (lib/ai/typesafe.ts) refuses a payload marked health-bearing unless attested.
 *
 * No imports beyond the pure local check: the builders are client-reachable.
 */
import { mayReachJev } from "@/lib/profile/taste-safety";

/** `JEV_HEALTH_ATTESTED=1`: the owner recorded TypeSafe's health-data terms. Unset in production. */
export function jevHealthAttested(): boolean {
  return typeof process !== "undefined" && process.env?.JEV_HEALTH_ATTESTED === "1";
}

/** True when free text is proven free of health context by the local check. */
export function jevTextCleared(text: string): boolean {
  return mayReachJev(text);
}

/** The adapter's warning when it refuses a health-bearing payload. */
export const JEV_HEALTH_REFUSAL = "health-bearing payload: JEV_HEALTH_ATTESTED is not set";
