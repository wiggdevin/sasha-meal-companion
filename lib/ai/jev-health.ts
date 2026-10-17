/**
 * OD12 (docs/decisions/2026-10-12-owner-decisions.md): a gate for health-bearing Jev payloads.
 * Off by default: Jev keeps every text path while the app is tested in-house (owner, 2026-10-17).
 * `JEV_HEALTH_GATE=1` (manual, never inferred) turns it on, and then no text that may carry health
 * context reaches TypeSafe. Turn it on before anyone outside in-house testing uses the app, unless
 * TypeSafe's health-data terms are recorded in docs/ai-data-handling.md by then.
 *
 * "May carry health context" is decided the conservative way round: free text is clean only when
 * the W5b local check clears it (`mayReachJev`: plain likes and dislikes built from known words, or
 * a message that is wholly one app command). Anything the check does not clear counts as health
 * text, so a mistake can only keep plain text local, never send health text out.
 *
 * The payload builders (lib/ai/payloads.ts) use `jevTextCleared` to drop or mark free text, and the
 * TypeSafe adapter (lib/ai/typesafe.ts) refuses a payload marked health-bearing while the gate is on.
 *
 * No imports beyond the pure local check: the builders are client-reachable.
 */
import { mayReachJev } from "@/lib/profile/taste-safety";

/** `JEV_HEALTH_GATE=1`: health-bearing payloads stay off Jev. Unset (off) by default. */
export function jevHealthGateOn(): boolean {
  return typeof process !== "undefined" && process.env?.JEV_HEALTH_GATE === "1";
}

/** True when free text is proven free of health context by the local check. */
export function jevTextCleared(text: string): boolean {
  return mayReachJev(text);
}

/** The adapter's warning when it refuses a health-bearing payload. */
export const JEV_HEALTH_REFUSAL = "health-bearing payload: JEV_HEALTH_GATE is on";
