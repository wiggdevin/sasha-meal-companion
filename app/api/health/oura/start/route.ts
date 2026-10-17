/**
 * /api/health/oura/start — spec §5: JWT, 10/hour/user.
 *
 * POST (Phase 9 slice 1, audit plan r3 finding 4) answers `{ url }` after `requireUser`, so a tab
 * whose `x-smc-account` is not the session's user gets 409 before any OAuth state is bound; the
 * client then navigates to the absolute Oura URL. The old navigation GET is removed (PR #248 review
 * r1 #2): it carried no account header, so an old tab could bind Oura to whichever account the
 * shared cookie held. An old tab's tap now gets 405 and starts nothing; after its reload it POSTs.
 */
import { HttpError, requireUser } from "@/lib/server/auth";
import { adminClient } from "@/lib/server/admin";
import { jsonError } from "@/lib/server/http";
import { startOura } from "@/lib/server/oura";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { safeReturnTo } from "@/lib/health/oura-return";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The body is only an optional same-origin return path. */
const MAX_BODY_BYTES = 1024;

async function startForUser(req: Request): Promise<string> {
  if (!process.env.HEALTH_INGEST_ENABLED) {
    throw new HttpError(503, "unavailable", "Health ingest is off.");
  }
  const { userId } = await requireUser(req);
  await enforceRateLimit(`health:oura:start:${userId}`, 10, 3600);
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Body too large.");
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Body too large.");
  let requested: unknown;
  if (raw) {
    try {
      const body: unknown = JSON.parse(raw);
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new Error("invalid body");
      requested = (body as { returnTo?: unknown }).returnTo;
    }
    catch { throw new HttpError(400, "bad_request", "Invalid request body."); }
  }
  const origin = new URL(req.url).origin;
  const returnTo = requested === undefined ? "/settings" : safeReturnTo(requested, origin);
  if (!returnTo) throw new HttpError(400, "bad_request", "Invalid return path.");
  const { url } = returnTo === "/settings"
    ? await startOura(adminClient(), userId)
    : await startOura(adminClient(), userId, new Date(), returnTo);
  return url;
}

export async function POST(req: Request): Promise<Response> {
  try {
    return Response.json({ url: await startForUser(req) });
  } catch (e) {
    return jsonError(e);
  }
}
