/**
 * GET /api/sync/changes?since=<seq>&limit=<≤500> — one page of the change feed. §5 matrix:
 * Supabase JWT, 60/min/user. The client saves `next_cursor` only after it has applied the whole
 * page (architecture §3.7).
 */
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import type { ChangeRow, ChangesResponse } from "@/lib/sync/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;

function parseCount(raw: string | null, fallback: number, max: number, field: string): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, "bad_request", `${field} must be a non-negative integer`);
  }
  return Math.min(Number(raw), max);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`sync:changes:${userId}`, RATE_LIMIT, RATE_WINDOW_SECONDS, "fail_open");

    const params = new URL(req.url).searchParams;
    const since = parseCount(params.get("since"), 0, Number.MAX_SAFE_INTEGER, "since");
    const limit = Math.max(1, parseCount(params.get("limit"), MAX_LIMIT, MAX_LIMIT, "limit"));

    const { data, error } = await client.rpc("sync_changes", {
      p_user_id: userId, p_since: since, p_limit: limit,
    });
    if (error) throw new HttpError(500, "internal", error.message);

    const changes = (data ?? []) as ChangeRow[];
    const payload: ChangesResponse = {
      changes,
      next_cursor: changes.length > 0 ? changes[changes.length - 1].seq : since,
      has_more: changes.length === limit,
    };
    return Response.json(payload);
  } catch (e) {
    return jsonError(e);
  }
}
