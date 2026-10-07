import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    const rows = await client.from("favorites_catalog_recipes")
      .select("recipe_id,rev,sort").eq("user_id", userId).is("deleted_at", null).order("sort");
    if (rows.error) throw rows.error;
    const ids = (rows.data ?? []).map((row) => row.recipe_id);
    const roots = ids.length ? await client.from("recipe_catalog")
      .select("id,current_revision_id,publication_state")
      .in("id", ids) : { data: [], error: null };
    if (roots.error) throw roots.error;
    const rootById = new Map((roots.data ?? []).map((row) => [row.id, row]));
    const revisionIds = (roots.data ?? []).map((row) => row.current_revision_id)
      .filter((id): id is string => typeof id === "string");
    const revisions = revisionIds.length ? await client.from("recipe_catalog_revisions")
      .select("id,name").in("id", revisionIds) : { data: [], error: null };
    if (revisions.error) throw revisions.error;
    const names = new Map((revisions.data ?? []).map((row) => [row.id, row.name]));
    return Response.json({ favorites: (rows.data ?? []).map((row) => {
      const root = rootById.get(row.recipe_id);
      return { recipeId: row.recipe_id, name: root?.current_revision_id
        ? names.get(root.current_revision_id) ?? "Saved recipe" : "Saved recipe",
      revision: row.rev, sort: row.sort,
      withdrawn: root?.publication_state === "withdrawn" };
    }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
