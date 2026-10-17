/** DELETE /api/health/tokens/[id] — revoke. The row stays so its samples keep their foreign key. */
import { adminClient } from "@/lib/server/admin";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { parseUuid } from "@/lib/server/validate";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request,
    ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:tokens:${userId}`, 20, 3600);
    const id = parseUuid((await ctx.params).id, "source id");

    const { data, error } = await adminClient().from("health_sources")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", userId)      // §2.2 rule 3: never an unscoped write
      .select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "not_found", "No such source.");
    return Response.json({ ok: true, id });
  } catch (e) {
    return jsonError(e);
  }
}
