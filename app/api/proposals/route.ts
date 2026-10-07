/** GET /api/proposals?status=pending — JWT, read-only, 60/min/user. */
import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { listProposals } from "@/lib/server/proposals";
import type { ProposalSummary } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["pending", "approved", "rejected"]);

export async function GET(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`proposals:ip:${ip}`, 60, 60, "fail_open");
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`proposals:user:${userId}`, 60, 60, "fail_open");
    const raw = new URL(req.url).searchParams.get("status");
    const status = raw && STATUSES.has(raw) ? (raw as ProposalSummary["status"]) : undefined;
    return Response.json(await listProposals(client, userId, status));
  } catch (e) {
    return jsonError(e);
  }
}
