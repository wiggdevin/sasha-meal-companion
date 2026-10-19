/**
 * POST /api/shopping/build/rank — the Have AI build my list Ingredients deck order (UI makeover W8
 * §7.3). `{ candidates: { id, name }[] }` (1–30, distinct ids) in, `{ order, provenance }` out:
 * every input id exactly once. Jev may only reorder (lib/server/shopping-build-rank.ts); any Jev
 * failure answers the input order with app provenance. Shopping pilot only (404 otherwise), the
 * shared limiter (fail closed), 16 KB, no-store, inside the per-request Jev budget.
 */
import { withJevBudget } from "@/lib/ai/request-budget";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { rankShoppingCandidates, shoppingRankRequestSchema } from "@/lib/server/shopping-build-rank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 16 * 1024;

export async function POST(req: Request): Promise<Response> {
  return withJevBudget(async () => {
    try {
      const { userId } = await requireRecipeUser(req);
      await enforceRateLimit(`shopping-build-rank:${userId}`, 10, 60);
      const body = await readJson(req, shoppingRankRequestSchema, MAX_BYTES);
      const answer = await rankShoppingCandidates(body, userId);
      return Response.json(answer, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return jsonError(error);
    }
  });
}
