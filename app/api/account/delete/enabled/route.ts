import { requireUser } from "@/lib/server/auth";
import { accountDeletionEnabled } from "@/lib/server/account-deletion-flag";
import { jsonError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * GET → `{ enabled }`: may Settings show "Delete account"? The answer is `ACCOUNT_DELETION_ENABLED`,
 * the same switch `POST /api/account/delete` reads. Side-effect free: no write, no limiter counter
 * (as `GET /api/profile/taste/enabled`). Auth required (401 without a session). No-store. The phone
 * treats any answer but 200 `{ enabled: true }` as off.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req);
    return Response.json({ enabled: accountDeletionEnabled() }, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }
}
