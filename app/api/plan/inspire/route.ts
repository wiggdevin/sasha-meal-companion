/**
 * POST /api/plan/inspire — JWT, 4 KB, burst 20/min per user. A photo path or a recipe link in;
 * a dish title and plain food names out (lib/server/plan-inspire.ts). Nothing is planned or saved.
 */
import { inspireRequestSchema } from "@/lib/plan/inspire-types";
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { rateLimitKey } from "@/lib/server/capture-rate-limit";
import { jsonError, readJson } from "@/lib/server/http";
import { inspire } from "@/lib/server/plan-inspire";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Supabase project's own region (us-west-1 -> sfo1), as vercel.json "regions".
export const preferredRegion = ["sfo1"];
export const maxDuration = 30;

const MAX_BYTES = 4 * 1024;

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(rateLimitKey(req, "plan:inspire"), 30, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`plan:inspire:user:${userId}`, 20, 60);
    const body = await readJson(req, inspireRequestSchema, MAX_BYTES);
    return Response.json(await inspire(adminClient(), client, userId, body));
  } catch (e) {
    return jsonError(e);
  }
}
