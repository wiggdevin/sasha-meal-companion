import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceInstanceRateLimit, enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function current(client: Awaited<ReturnType<typeof requireUser>>["client"], userId: string) {
  const { data, error } = await client.from("user_settings")
    .select("diet_prefs,rev").eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(503, "diet_unavailable", "Diet settings could not load.");
  if (!data) throw new HttpError(409, "profile_required", "Finish your profile first.");
  return { data };
}

export async function GET(req: Request): Promise<Response> {
  try {
    // W047: the pre-auth guard is this instance's memory only; the shared count is per account.
    await enforceInstanceRateLimit(`foods:diet:pre:ip:${requestIp(req)}`, 120, 60);
    const { client, userId } = await requireUser(req);
    await enforceRateLimit(`foods:diet:${userId}`, 30, 60, "fail_open");
    const { data } = await current(client, userId);
    return Response.json({ dietPrefs: data.diet_prefs, rev: data.rev },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
