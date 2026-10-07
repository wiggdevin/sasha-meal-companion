import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { confirmFoodRole } from "@/lib/server/food-role-confirm";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  foodRefId: z.uuid(),
  proposedRole: z.enum(["protein", "carb", "fat"]),
  currentRole: z.enum(["protein", "carb", "fat"]).nullable(),
  requiresConfirmation: z.literal(true),
}).strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods:role-confirm:${userId}`, 30, 60);
    const body = await readJson(req, Body, 512);
    return Response.json(await confirmFoodRole(client, userId, body));
  } catch (error) {
    return jsonError(error);
  }
}
