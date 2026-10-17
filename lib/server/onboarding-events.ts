import "server-only";

/**
 * The store behind `POST /api/onboarding/events` (Followups #18). One call of
 * `record_onboarding_events_for` (migration 20270105140000, W070) with the admin client and the
 * session-verified user id: `authenticated` can no longer insert into `onboarding_events` or call
 * the invoker RPC (20270105140300), so the route's rate limit is the only way in. The function
 * skips an event whose shape does not match its kind or whose clock is out of window (rejected)
 * and a repeated `client_event_id` (duplicate), so a retry never double-inserts.
 */
import { adminClient } from "@/lib/server/admin";
import { onboardingEventRow, type OnboardingEvent } from "@/lib/profile/onboarding-events";

export type OnboardingEventStoreResult = { inserted: number; duplicates: number; rejected: number };

export class OnboardingEventStoreError extends Error {
  constructor(public readonly code: string) {
    super(`record_onboarding_events_for failed (${code})`);
    this.name = "OnboardingEventStoreError";
  }
}

export async function recordOnboardingEvents(
  userId: string, events: readonly OnboardingEvent[],
): Promise<OnboardingEventStoreResult> {
  const { data, error } = await adminClient().rpc("record_onboarding_events_for",
    { p_user_id: userId, p_events: events.map(onboardingEventRow) });
  if (error) throw new OnboardingEventStoreError(error.code ?? "unknown");
  const row = (Array.isArray(data) ? data[0] : data) as Partial<OnboardingEventStoreResult> | null;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const inserted = n(row?.inserted);
  const duplicates = n(row?.duplicates);
  const rejected = n(row?.rejected);
  if (inserted === null || duplicates === null || rejected === null) {
    throw new OnboardingEventStoreError("bad_result");
  }
  return { inserted, duplicates, rejected };
}
