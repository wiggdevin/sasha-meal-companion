/**
 * Onboarding v2 (BRIEF.md §5 "Cost"): "Target under 5 model calls per onboarding." The regex
 * fast path and the local safety check are free (zero model calls); only the one bounded
 * extraction call and Jev's confidence check, if either ever runs, count against this.
 *
 * `onboardingCallBudgetRemaining` is a pure, client-trustable-only helper: it is NOT the
 * enforcement (Sol r1 BLOCK 2 on a draft of this lane: a client that always reports 0 would
 * never be stopped by a check that only reads what the client sent). The actual budget is
 * enforced server-side, in lib/server/onboarding-extract.ts, through the shared Postgres-backed
 * rate limiter (lib/server/ratelimit.ts) keyed per user — the same mechanism every other
 * server-enforced limit in this app uses, so it survives a cold start and is shared across
 * instances. This module stays useful for the UI's own local "how many do I have left" display.
 */

/** BRIEF.md §5: "Target under 5 model calls per onboarding session." Also the limit
 *  lib/server/onboarding-extract.ts passes to the server-side rate limiter. */
export const ONBOARDING_MAX_MODEL_CALLS = 5;

/** The window the server-side budget (lib/server/onboarding-extract.ts) counts calls over, per
 *  account. A day, not half an hour (final Sol review WARN): onboarding resumes from its draft,
 *  so a session left open and picked up later must not get a fresh five attempts. */
export const ONBOARDING_SESSION_WINDOW_SECONDS = 24 * 60 * 60;

/** A local, non-authoritative estimate of whether one more model call is still within budget,
 *  from the caller's OWN count of calls it has seen succeed. Useful for the UI's own display;
 *  never the security boundary (see file header) — the server re-counts independently. */
export function onboardingCallBudgetRemaining(callsUsedSoFar: number): boolean {
  return Number.isFinite(callsUsedSoFar) && callsUsedSoFar < ONBOARDING_MAX_MODEL_CALLS;
}
