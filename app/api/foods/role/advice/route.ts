import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { adviseMemberFoodRoles, MAX_ROLE_ADVICE_FOODS } from "@/lib/server/food-role-advice";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  foodRefIds: z.array(z.uuid()).min(1).max(MAX_ROLE_ADVICE_FOODS),
}).strict();

/**
 * POST /api/foods/role/advice — Foods › add-food asks, after a food reaches Eats or Avoid, which
 * macro group it belongs to. One entry per requested id, in order; `roleAdvice` is present only
 * for a member food with no stored role and a usable answer. Advisory only: nothing is written,
 * and the user's yes goes through POST /api/foods/role/confirm. An advice failure is a 200 with
 * no advice — the add has already happened and must not look failed.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods:role-advice:${userId}`, 30, 60);
    const { foodRefIds } = await readJson(req, Body, 1024);
    const advice = await adviseMemberFoodRoles(client, userId, foodRefIds);
    return Response.json({
      items: foodRefIds.map((foodRefId) => {
        const roleAdvice = advice.get(foodRefId);
        return roleAdvice ? { foodRefId, roleAdvice } : { foodRefId };
      }),
    });
  } catch (error) {
    return jsonError(error);
  }
}
