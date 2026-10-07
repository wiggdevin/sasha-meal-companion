/**
 * POST /api/log/commit — JWT, 64 KB, 60/min/user, idempotent on entry_id.
 *
 * The route decides nothing about logging: it enforces the §5 matrix row, hands the parsed body
 * to applyLogEntry, and maps that result onto a status code. Contracts §8 order: rate limit,
 * then identity, then body.
 */

import { z } from "zod";
import { adminClient } from "@/lib/server/admin";
import { afterResponse } from "@/lib/server/after-response";
import { applyLogEntry } from "@/lib/server/log";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// T0 §5: fluid-compute function config. The region is pinned to the Supabase project's own
// (us-west-1 -> sfo1, as vercel.json "regions") so every query in this route is a short hop,
// and `maxDuration` is the client budget in lib/fetch-with-deadline.ts plus room for the
// response, never more.
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

const MAX_BYTES = 64 * 1024;

/** Shape is applyLogEntry's business; readJson only guards the size and the JSON-ness. */
const envelope = z.record(z.string(), z.unknown());

const STATUS: Record<string, number> = { ok: 200, conflict: 409, deleted: 409,
  stale_revision: 409, gone: 410, invalid: 422 };

export async function POST(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`log:commit:ip:${ip}`, 60, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`log:commit:user:${userId}`, 60, 60);

    const body = await readJson(req, envelope, MAX_BYTES);
    const result = await applyLogEntry(client, userId, body,
      { admin: adminClient(), labelFood: (body as { label_food?: unknown }).label_food });
    if (result.status === "ok" && result.user_food_id) afterResponse(async () => {
      try {
        const { ensureUserFoodFacets } = await import("@/lib/foods/facet-warm");
        await ensureUserFoodFacets([result.user_food_id as string], { userId });
      } catch (error) {
        console.error("user-food facet warm failed", { error });
      }
    });
    return Response.json(result, { status: STATUS[result.status] ?? 500 });
  } catch (e) {
    return jsonError(e);
  }
}
