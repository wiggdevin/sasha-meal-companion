/**
 * POST /api/plan/ideas — one Plan-sheet chip (lib/plan/chips.ts): JWT, 2 KB, the shared limiter
 * (120/min per IP before auth, 60/min per account after), fail closed, no-store. Code builds the
 * cards (lib/server/plan-ideas.ts); no coach turn and no generative model. Jev may rank them under
 * a hard deadline, so the route runs inside the per-request Jev budget like /api/coach.
 * Nothing is planned or saved: "Put it in" is the same slot write every Plan card uses.
 */
import { withJevBudget } from "@/lib/ai/request-budget";
import { planIdeasRequestSchema } from "@/lib/plan/chips";
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { planIdeas } from "@/lib/server/plan-ideas";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Supabase project's own region (us-west-1 -> sfo1), as vercel.json "regions".
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

const MAX_BYTES = 2 * 1024;

export async function POST(req: Request): Promise<Response> {
  return withJevBudget(async () => {
    try {
      await enforceRateLimit(`plan:ideas:pre:ip:${requestIp(req)}`, 120, 60);
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`plan:ideas:user:${userId}`, 60, 60);
      const body = await readJson(req, planIdeasRequestSchema, MAX_BYTES);
      const answer = await planIdeas(client, adminClient(), userId, body);
      return Response.json(answer, { headers: {
        "Cache-Control": "no-store",
        "Server-Timing": `ideas;dur=${answer.serverMs}`,
      } });
    } catch (error) {
      return jsonError(error);
    }
  });
}
