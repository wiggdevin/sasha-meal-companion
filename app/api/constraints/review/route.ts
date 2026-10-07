import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { completeRuleReview, getRuleReviewStatus } from "@/lib/server/constraints";
import { adminClient } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const choices = z.record(z.string(), z.enum(["keep", "remove"]));
const request = z.object({
  baseRev: z.number().int().nonnegative(),
  choices: z.object({ allergens: choices, categories: choices }),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`rule-review:pre:ip:${requestIp(req)}`, 120, 60, "fail_open");
    const { client, userId } = await requireUser(req);
    await enforceRateLimit(`rule-review:${userId}`, 30, 60, "fail_open");
    return Response.json(await getRuleReviewStatus(client, userId));
  } catch (e) { return jsonError(e); }
}

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`rule-review:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId } = await requireUser(req);
    await enforceRateLimit(`rule-review:${userId}`, 30, 60);
    const body = await readJson(req, request, 8 * 1024);
    // Only this verified route may stamp the server-owned marker. Authenticated PostgREST
    // clients have no INSERT/UPDATE grant on its columns.
    const result = await completeRuleReview(adminClient(), userId, body.baseRev, body.choices);
    if (result.status === "conflict") return Response.json(result, { status: 409 });
    return Response.json({ ...result, review: await getRuleReviewStatus(adminClient(), userId) });
  } catch (e) { return jsonError(e); }
}
