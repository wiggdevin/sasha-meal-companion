/**
 * GET /api/media/thumbnail?entry=<uuid> — a plate photo's kept 512 px copy (W125, T2 D2), as a
 * signed read URL good for an hour, or `{ url: null }` when the entry has none.
 *
 * Runs entirely on the caller's own session: the `media_objects` row is read through its owner-only
 * RLS, the path is re-checked as exactly one of the caller's own objects (`ownedObjectKey`), and
 * the URL is signed by Storage under the bucket's own-folder policy. No service-role client, so
 * another account's entry id answers the same `{ url: null }` as an entry with no photo.
 */
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { MEDIA_BUCKET, ownedObjectKey } from "@/lib/server/media";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a signed URL reads; the phone caches it for a little less (lib/media/thumbnail-client.ts). */
const THUMBNAIL_URL_SECONDS = 60 * 60;

const entryId = z.string().uuid();
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`media:thumbnail:user:${userId}`, 120, 60);
    const parsed = entryId.safeParse(new URL(req.url).searchParams.get("entry"));
    if (!parsed.success) throw new HttpError(400, "invalid", "entry must be a uuid");
    const row = await client.from("media_objects").select("path")
      .eq("entry_id", parsed.data).eq("user_id", userId).eq("kind", "image").is("deleted_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (row.error) throw new HttpError(503, "unavailable", "Could not read the photo.");
    const key = row.data ? ownedObjectKey((row.data as { path: string }).path, userId) : null;
    if (key === null) return Response.json({ url: null }, { headers: NO_STORE });
    const signed = await client.storage.from(MEDIA_BUCKET).createSignedUrl(key, THUMBNAIL_URL_SECONDS);
    if (signed.error || !signed.data) return Response.json({ url: null }, { headers: NO_STORE });
    return Response.json({ url: signed.data.signedUrl, expiresInSeconds: THUMBNAIL_URL_SECONDS },
      { headers: NO_STORE });
  } catch (e) {
    return jsonError(e);
  }
}
