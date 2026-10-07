import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { rebalanceAccessEnabled } from "@/lib/server/rebalance-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    return Response.json({ enabled: rebalanceAccessEnabled(userId) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
