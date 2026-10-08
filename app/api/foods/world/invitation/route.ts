import { requireUser } from "@/lib/server/auth";
import { adminClient } from "@/lib/server/admin";
import { invitationEligible } from "@/lib/server/food-world";
import { jsonError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * W13 (D14): whether to show this account the dismissible open-world invitation. `{ eligible }`
 * only — no reason is given, so a held account (acceptance 4) is indistinguishable from one that
 * is simply already open or sees the open world unreleased; the allowlist that decides it never
 * surfaces to the client. Side-effect free, private, no-store.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const eligible = await invitationEligible(adminClient(), userId);
    return Response.json({ eligible }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
