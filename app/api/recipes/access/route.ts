import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { recipeAccessEnabled } from "@/lib/server/recipe-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    return Response.json({ enabled: recipeAccessEnabled(userId) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
