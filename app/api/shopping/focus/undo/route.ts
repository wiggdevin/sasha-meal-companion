import { z } from "zod";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { undoShoppingFocus } from "@/lib/server/shopping-focus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ actionId: z.string().uuid() }).strict();

/**
 * Undo one shopping-focus write by the id the write answered. The server restores the value it
 * recorded as that write's previous, only while that write is still the latest (compare-and-set):
 * `{ status: "undone", until }`, or `{ status: "superseded", until }` with nothing written when a
 * later choice (or this Undo) came first. Same Shopping gate as the write (404 without access).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-focus:${userId}`, 30, 60);
    const body = await readJson(req, Body, 200);
    const result = await undoShoppingFocus(userId, body.actionId);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
