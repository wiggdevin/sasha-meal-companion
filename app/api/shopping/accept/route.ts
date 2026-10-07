import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { acceptPreview, noStore } from "@/lib/server/recipe-plan";
import { shoppingAcceptBody } from "@/lib/shopping/preview-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-accept:${userId}`, 12, 60);
    const body = await readJson(req, shoppingAcceptBody, 2000);
    const preview = await client.from("recipe_plan_previews").select("kind")
      .eq("id", body.previewId).eq("user_id", userId).maybeSingle();
    if (preview.error) throw new HttpError(503, "preview_unavailable", undefined, { cause: preview.error });
    if (preview.data?.kind !== "shopping") throw new HttpError(404, "not_found", "Shopping preview not found.");
    const accepted = await acceptPreview(client, userId, body.previewId, body.requestId, true);
    const lines = await markShoppingItems(client, userId, accepted.lines);
    return Response.json({ ...accepted, lines }, { headers: noStore });
  } catch (error) { return jsonError(error); }
}
