/**
 * The private media bucket, server side (§4.2, spec §8).
 *
 * The path is built here and never read from a request body: a media_ref from the client is a
 * claim, not a capability. Every read re-checks the whole path before the object is touched
 * (`ownedObjectKey`: exactly `media/<caller uid>/<uuid>.<ext>`), so a foreign or traversal path
 * (`media/<mine>/../<theirs>/…`, which fetch would normalise into another account's object) costs
 * one comparison and zero bytes of download (audit 2026-10-10 A115, A099, A136).
 *
 * The media_objects row is written at SIGN time with the DECLARED size, so an abandoned capture is
 * still visible to the 24-hour sweep even if the upload never completes.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignRequest, SignResponse } from "@/lib/capture/types";
import { HttpError } from "@/lib/server/auth";

export const MEDIA_BUCKET = "media";
/**
 * Storage's own lifetime for a signed upload URL: hosted Supabase documents two hours, and
 * `createSignedUploadUrl` takes no expiry, so the app cannot shorten it (audit 2026-10-10 P10; the
 * old fixed "60 s" was only a label). The sign route reports the token's real `exp`, and this
 * ceiling only when the token cannot be read.
 */
export const SIGNED_UPLOAD_MAX_SECONDS = 2 * 60 * 60;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

/** MIME → extension, restricted to the bucket's allowed_mime_types (migration 20260920090100). */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png",
  "audio/mp4": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/wav": "wav",
};
const KIND_OF: Record<string, "image" | "audio"> = {
  "image/jpeg": "image", "image/png": "image",
  "audio/mp4": "audio", "audio/aac": "audio", "audio/mpeg": "audio", "audio/wav": "audio",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An account id as a folder name: never empty, a dot segment or a separator. */
const SEGMENT = /^[0-9A-Za-z-]+$/;
/** The one object name signUpload mints (`<uuid>.<ext>`); `jpeg` is what the Plan routes accept. */
const OBJECT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|m4a|aac|mp3|wav)$/i;

export function objectKey(path: string): string {
  return path.startsWith(`${MEDIA_BUCKET}/`) ? path.slice(MEDIA_BUCKET.length + 1) : path;
}

/**
 * The bucket key of `path` when it is exactly one of `userId`'s own media objects
 * (`media/<userId>/<uuid>.<ext>`), else null. No dot, empty or extra segment, no encoded or
 * backslash form, no other prefix: the key handed to the service-role client is the one checked.
 * The media_objects CHECK (migration 20261230091900) holds rows to the same shape.
 */
export function ownedObjectKey(path: string, userId: string): string | null {
  if (!SEGMENT.test(userId) || !path.startsWith(`${MEDIA_BUCKET}/`)) return null;
  const parts = path.slice(MEDIA_BUCKET.length + 1).split("/");
  if (parts.length !== 2 || parts[0] !== userId || !OBJECT_NAME.test(parts[1])) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** Seconds until the signed upload token in `uploadUrl` expires: its own JWT `exp`, read without
 *  verifying (Storage verifies it on the PUT), or `SIGNED_UPLOAD_MAX_SECONDS` when unreadable. */
export function signedUploadSeconds(uploadUrl: string, now: number = Date.now()): number {
  try {
    const token = new URL(uploadUrl).searchParams.get("token") ?? "";
    const payload = token.split(".")[1];
    if (!payload) return SIGNED_UPLOAD_MAX_SECONDS;
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    const left = typeof exp === "number" ? Math.floor(exp - now / 1000) : NaN;
    return Number.isFinite(left) && left > 0 ? left : SIGNED_UPLOAD_MAX_SECONDS;
  } catch {
    return SIGNED_UPLOAD_MAX_SECONDS;
  }
}

export function draftIdFromPath(path: string): string | null {
  const name = objectKey(path).split("/")[1] ?? "";
  const id = name.slice(0, name.lastIndexOf("."));
  return UUID.test(id) ? id.toLowerCase() : null;
}

export async function signUpload(
  admin: SupabaseClient, userId: string, req: SignRequest
): Promise<SignResponse> {
  const extension = EXTENSIONS[req.contentType];
  if (!extension || KIND_OF[req.contentType] !== req.kind) {
    throw new HttpError(415, "unsupported_media", "That file type cannot be uploaded.");
  }
  if (!Number.isFinite(req.bytes) || req.bytes <= 0 || req.bytes > MAX_OBJECT_BYTES) {
    throw new HttpError(413, "too_large", "That file is too large.");
  }
  const path = `${MEDIA_BUCKET}/${userId}/${randomUUID()}.${extension}`;
  // The row goes in FIRST so a declared-but-never-uploaded object is visible to the 24-hour sweep
  // from the moment it is promised, not from the moment the signed URL happens to succeed.
  const row = await admin.from("media_objects")
    .insert({ path, user_id: userId, kind: req.kind, bytes: req.bytes });
  if (row.error) throw new HttpError(500, "internal", "Could not record the upload.");
  const signed = await admin.storage.from(MEDIA_BUCKET).createSignedUploadUrl(objectKey(path));
  if (signed.error || !signed.data) {
    const tombstone = await admin.from("media_objects")
      .update({ deleted_at: new Date().toISOString() }).eq("path", path);
    if (tombstone.error) {
      console.error("media_objects tombstone after sign failure failed", { path, error: tombstone.error });
    }
    throw new HttpError(500, "internal", "Could not prepare the upload.");
  }
  return { path, uploadUrl: signed.data.signedUrl,
    expiresInSeconds: signedUploadSeconds(signed.data.signedUrl) };
}

export async function fetchOwnedObject(
  admin: SupabaseClient, userId: string, path: string
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const key = ownedObjectKey(path, userId);
  if (key === null) {
    throw new HttpError(403, "media_not_owned", "That file is not yours.");
  }
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).download(key);
  if (error || !data) throw new HttpError(404, "not_found", "That file is no longer there.");
  const buffer = await data.arrayBuffer();
  return { bytes: new Uint8Array(buffer), mimeType: data.type };
}

/**
 * Removes the stored object, then tombstones its row. A missing object is the desired end state
 * (Storage answers it without an error), so the row is tombstoned. A failed removal throws and
 * leaves the row live: the object may still be there, and the daily sweep retries it (scale S3; a
 * tombstone here would hide the object from every later sweep). A failed tombstone is logged, not
 * thrown: the object is gone, and the sweep's next delete of a missing object only re-tombstones.
 */
export async function deleteMedia(admin: SupabaseClient, path: string): Promise<void> {
  const { error } = await admin.storage.from(MEDIA_BUCKET).remove([objectKey(path)]);
  if (error) {
    console.error("media object delete failed; the row stays for the sweep", { path, error });
    throw new Error(`media object delete failed: ${path}`);
  }
  const tombstone = await admin.from("media_objects")
    .update({ deleted_at: new Date().toISOString() }).eq("path", path);
  if (tombstone.error) {
    console.error("media_objects tombstone failed", { path, error: tombstone.error });
  }
}
