import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { RecipeRulesUnchecked } from "@/lib/server/recipe-candidates";
import { noStore, previewRecipe } from "@/lib/server/recipe-plan";
import { recipePreviewBody } from "@/lib/shopping/preview-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) throw new HttpError(400, "bad_request", "Invalid recipe ID.");
    await enforceRateLimit(`recipe-preview:${userId}`, 30, 60);
    const body = await readJson(req, recipePreviewBody, 2000);
    return Response.json(await previewRecipe(client, userId, id, body), { headers: noStore });
  } catch (error) {
    if (error instanceof RecipeRulesUnchecked) {
      return Response.json({ error: error.code, message: error.message, ruleMark: error.ruleMark },
        { status: error.status, headers: noStore });
    }
    return jsonError(error);
  }
}
