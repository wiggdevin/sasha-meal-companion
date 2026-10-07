/** GET the profile, PUT with a baseRev compare-and-swap. JWT, 8 KB, 30/min/user (architecture §5). */

import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { getProfile, putProfile } from "@/lib/server/constraints";
import { constraintsPutSchema } from "@/lib/coach/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`constraints:pre:ip:${requestIp(req)}`, 120, 60, "fail_open");
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`constraints:${userId}`, 30, 60, "fail_open");
    return Response.json(await getProfile(client, userId));
  } catch (e) {
    return jsonError(e);
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`constraints:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`constraints:${userId}`, 30, 60);
    const body = await readJson(req, constraintsPutSchema, 8 * 1024);
    const result = await putProfile(client, userId, body);
    // A conflict is an answer, not an error: it carries the full current profile so the editor
    // rebases without a second round trip (architecture §3.7).
    return Response.json(result, { status: result.status === "conflict" ? 409 : 200 });
  } catch (e) {
    return jsonError(e);
  }
}
