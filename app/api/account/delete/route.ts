import { z } from "zod";
import { deleteAccount, requireRecentSignIn } from "@/lib/server/account-delete";
import { accountDeletionEnabled } from "@/lib/server/account-deletion-flag";
import { adminClient } from "@/lib/server/admin";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/** The typed confirmation travels with the request, so no stray POST can delete an account. */
const bodySchema = z.object({ confirm: z.literal("DELETE") }).strict();

/**
 * Self-serve account deletion (lib/server/account-delete.ts has the order and why it is safe).
 *
 * Dark until `ACCOUNT_DELETION_ENABLED=1` (404 `not_enabled`, before any read). Identity is the
 * verified session only (`requireUser`; the account header must match it, never stands in for it).
 * Fail-closed limiter (pre-auth per IP, then per account). The session must come from a sign-in in
 * the last 10 minutes, else 401 `reauth_required` and the phone sends a sign-in code first.
 * Idempotent: a repeat for an account already deleted answers 200 `already_gone`.
 *
 * Body `{ confirm: "DELETE" }`. 200 `{ status: "deleted" | "already_gone" }`; 400; 401
 * unauthorized | reauth_required; 404 not_enabled; 409 account_mismatch; 413; 429; 502
 * account_delete_failed; 503 rate_limit_unavailable | storage_unavailable |
 * account_deletion_unavailable (the database function is missing). No-store.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    if (!accountDeletionEnabled()) throw new HttpError(404, "not_enabled", "Account deletion is not available.");
    await enforceRateLimit(`account-delete:pre:ip:${requestIp(req)}`, 30, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`account-delete:${userId}`, 5, 600);
    await readJson(req, bodySchema, 256);
    await requireRecentSignIn(client);
    const result = await deleteAccount(adminClient(), userId);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
