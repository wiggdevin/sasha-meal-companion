import { z } from "zod";
import { getCatalogRecipe } from "@/lib/recipe-catalog/repository";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ favorite: z.boolean(), expectedRevision: z.number().int().positive().nullable(),
  requestId: z.uuid() });
type Context = { params: Promise<{ id: string }> };

async function idOf(context: Context): Promise<string> {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "bad_request", "Invalid recipe ID.");
  return id;
}

export async function GET(req: Request, context: Context): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    const id = await idOf(context);
    const result = await client.from("favorites_catalog_recipes")
      .select("rev,deleted_at").eq("user_id", userId).eq("recipe_id", id).maybeSingle();
    if (result.error) throw result.error;
    return Response.json({ favorite: Boolean(result.data && !result.data.deleted_at),
      revision: result.data?.rev ?? 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function PUT(req: Request, context: Context): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`recipe-favorite:${userId}`, 60, 60);
    const id = await idOf(context);
    const body = await readJson(req, Body, 1024);
    if (body.favorite && !(await getCatalogRecipe(client, id))) {
      throw new HttpError(404, "not_found", "Recipe not found.");
    }
    const old = await client.from("favorites_catalog_recipes")
      .select("rev,deleted_at,last_request_id")
      .eq("user_id", userId).eq("recipe_id", id).maybeSingle();
    if (old.error) throw old.error;
    if (old.data?.last_request_id === body.requestId) {
      return Response.json({ favorite: !old.data.deleted_at, revision: old.data.rev });
    }
    if (!old.data) {
      if (body.expectedRevision !== null) throw new HttpError(409, "stale_revision", "Favorite changed. Refresh and retry.");
      if (!body.favorite) return Response.json({ favorite: false, revision: 0 });
      const created = await client.from("favorites_catalog_recipes").insert({
        user_id: userId, recipe_id: id, rev: 1, last_request_id: body.requestId,
      }).select("rev,deleted_at").single();
      if (created.error) {
        if (created.error.code === "23505") throw new HttpError(409, "stale_revision", "Favorite changed. Refresh and retry.");
        throw created.error;
      }
      return Response.json({ favorite: true, revision: created.data.rev });
    }
    if (body.expectedRevision !== old.data.rev) {
      throw new HttpError(409, "stale_revision", "Favorite changed. Refresh and retry.");
    }
    const updated = await client.from("favorites_catalog_recipes").update({
      deleted_at: body.favorite ? null : new Date().toISOString(),
      rev: old.data.rev + 1, last_request_id: body.requestId,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId).eq("recipe_id", id).eq("rev", old.data.rev)
      .select("rev,deleted_at").maybeSingle();
    if (updated.error) throw updated.error;
    if (!updated.data) throw new HttpError(409, "stale_revision", "Favorite changed. Refresh and retry.");
    return Response.json({ favorite: !updated.data.deleted_at, revision: updated.data.rev });
  } catch (error) { return jsonError(error); }
}
