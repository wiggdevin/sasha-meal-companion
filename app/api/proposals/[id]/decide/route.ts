/** POST /api/proposals/[id]/decide — JWT, 4 KB, 30/min/user, `expectedStatus` CAS (spec
 *  "Security"). Approval is one transaction inside `approve_target_proposal`. */
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { parseUuid } from "@/lib/server/validate";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { decideProposal, ProposalConflictError } from "@/lib/server/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024;

const bodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  expectedStatus: z.literal("pending"),
});

export async function POST(
  req: Request, ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`proposals:decide:ip:${ip}`, 30, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`proposals:decide:${userId}`, 30, 60);

    const id = parseUuid((await ctx.params).id, "proposal id");
    const body = await readJson(req, bodySchema, MAX_BYTES);
    return Response.json(await decideProposal(client, userId, id, body));
  } catch (e) {
    if (e instanceof ProposalConflictError) {
      return Response.json({ error: "conflict",
        message: "This proposal was already decided.", current: e.current }, { status: 409 });
    }
    return jsonError(e);
  }
}
