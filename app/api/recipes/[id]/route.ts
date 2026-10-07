import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError } from "@/lib/server/http";
import { loadMarkedRecipeDetail } from "@/lib/server/recipe-candidates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request,
  context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "bad_request", "Invalid recipe ID.");
    const result = await loadMarkedRecipeDetail(client, userId, id);
    if (!result) throw new HttpError(404, "not_found", "Recipe not found.");
    // A rule read failure still answers the recipe, marked unknown, with no `ruleFlags`.
    return Response.json({ ...result.recipe,
      ...(result.preferenceFlags ? { ruleFlags: result.preferenceFlags } : {}) },
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
