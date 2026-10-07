import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { acceptedSelectionRuleMark } from "@/lib/server/recipe-candidates";
import { acceptPreview, noStore } from "@/lib/server/recipe-plan";
import { recipePlanBody } from "@/lib/shopping/preview-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) throw new HttpError(400, "bad_request", "Invalid recipe ID.");
    await enforceRateLimit(`recipe-plan:${userId}`, 20, 60);
    const body = await readJson(req, recipePlanBody, 2000);
    const preview = await client.from("recipe_plan_previews").select("kind,proof")
      .eq("id", body.previewId).eq("user_id", userId).maybeSingle();
    if (preview.error) throw new HttpError(503, "preview_unavailable", undefined, { cause: preview.error });
    if (preview.data?.kind !== "recipe" || preview.data.proof?.choices?.[0]?.recipeId !== id) {
      throw new HttpError(404, "not_found", "Recipe preview not found.");
    }
    const accepted = await acceptPreview(client, userId, body.previewId, body.requestId,
      body.acceptApproximate);
    // The written selection judged as the selection GET judges it (current rules, normalized
    // flags); a failed check is unknown, never a pass, and never fails the accepted write.
    const selection = accepted.selections[0];
    const { ruleMark, preferenceFlags } = await acceptedSelectionRuleMark(client, userId, selection);
    return Response.json({ selection: { ...selection, ruleMark },
      ...(preferenceFlags ? { ruleFlags: preferenceFlags } : {}) }, { headers: noStore });
  } catch (error) { return jsonError(error); }
}
