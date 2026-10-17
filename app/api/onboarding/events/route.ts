import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import {
  ONBOARDING_EVENTS_BODY_MAX_BYTES, OnboardingEventBatch,
} from "@/lib/profile/onboarding-events";
import { OnboardingEventStoreError, recordOnboardingEvents } from "@/lib/server/onboarding-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Followups #18: pilot-arm, question and step events for the W15 onboarding ablation
 * (lib/profile/onboarding-events.ts is the wire contract -- no answer content, no free text).
 * Body `{ events: OnboardingEvent[] }`, 1 to 20 events, at most 16 KB.
 *
 * 202 `{ accepted, rejected }` whatever the insert does, so onboarding is never blocked by this:
 * `rejected` counts events the database's `record_onboarding_events` skipped (a shape that does
 * not match its kind, a clock more than 10 minutes ahead or 14 days behind); `accepted` is what
 * was handed to the store. A failed insert is logged with its error code only (no event detail,
 * no user id) and still answers 202. 400 bad_request (not JSON or not the shape); 401; 413; 429
 * rate_limited (120/min per IP before auth, 60/min per account, the shared Postgres limiter, fail
 * closed); 503 rate_limit_unavailable. Always no-store.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`onboarding-events:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId } = await requireUser(req);
    await enforceRateLimit(`onboarding-events:${userId}`, 60, 60);
    const { events } = await readJson(req, OnboardingEventBatch, ONBOARDING_EVENTS_BODY_MAX_BYTES);
    let accepted = 0;
    let rejected = 0;
    try {
      const result = await recordOnboardingEvents(userId, events);
      accepted = result.inserted + result.duplicates;
      rejected = result.rejected;
    } catch (error) {
      console.warn("onboarding events: insert failed; answered 202", {
        code: error instanceof OnboardingEventStoreError ? error.code : "unexpected", events: events.length,
      });
      rejected = events.length;
    }
    return Response.json({ accepted, rejected }, { status: 202, headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
