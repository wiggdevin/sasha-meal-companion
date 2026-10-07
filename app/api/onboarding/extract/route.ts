/**
 * Onboarding v2 (BRIEF.md §5): POST /api/onboarding/extract — the one bounded model extraction
 * call, run only when the regex fast path (lib/coach/onboarding-fast-path.ts, zero model calls)
 * could not fill every required field with high confidence. JWT-gated, 2 KB body.
 *
 * `callsUsedThisSession` is the caller's own count (the onboarding draft the phone already
 * holds, per BRIEF.md §5's IDB draft): this route re-checks the budget server-side
 * (lib/coach/onboarding-call-budget.ts) rather than trust the client's count alone, same as
 * every other server-enforced limit in this app.
 */
import { z } from "zod";
import { runOnboardingExtraction } from "@/lib/server/onboarding-extract";
import { adminClient } from "@/lib/server/admin";
import { jsonError, readJson } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024;
const bodySchema = z.object({
  text: z.string().min(1).max(2_000),
  callsUsedThisSession: z.number().int().min(0).max(1_000),
}).strict();

export function POST(req: Request): Promise<Response> {
  return handle(req);
}

async function handle(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`onboarding-extract:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId } = await requireUser(req);
    await enforceRateLimit(`onboarding-extract:${userId}`, 10, 60);
    const { text, callsUsedThisSession } = await readJson(req, bodySchema, MAX_BYTES);
    const outcome = await runOnboardingExtraction(text, new Date(), {
      userId, admin: adminClient(), callsUsedThisSession,
    });
    return Response.json(outcome, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
