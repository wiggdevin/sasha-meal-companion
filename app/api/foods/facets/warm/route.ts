/**
 * POST /api/foods/facets/warm — JWT, 202 always, 6/hour/user.
 *
 * Marking a food Eats should not wait on Jev: this answers 202 immediately and warms the caller's
 * own Eats-list facets (lib/server/eats-facet-warm.ts) in `afterResponse`, the same best-effort
 * deferred slot the barcode and commit routes use. `lib/foods/prefs-client.ts` calls this,
 * debounced, right after a successful Eats mark — the daily `/api/jobs/facet-warm` cron is the
 * backstop for anyone who never triggers this path (a backfilled mark, a mark made offline).
 */
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { afterResponse } from "@/lib/server/after-response";
import { warmEatsFacets } from "@/lib/server/eats-facet-warm";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Supabase project's own region (us-west-1 -> sfo1), as vercel.json "regions".
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

/** A phone marking several foods Eats in a burst debounces to one call (prefs-client.ts); this
 *  only needs to survive a few of those bursts an hour, never a tight per-tap loop. */
const MAX_PER_HOUR = 6;

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`facets:warm:${userId}`, MAX_PER_HOUR, 3600);
    afterResponse(async () => {
      try {
        await warmEatsFacets(adminClient(), userId, { maxFoods: 10 });
      } catch (error) {
        console.error("eats facet warm failed", { userId, error });
      }
    });
    return new Response(null, { status: 202 });
  } catch (e) {
    return jsonError(e);
  }
}
