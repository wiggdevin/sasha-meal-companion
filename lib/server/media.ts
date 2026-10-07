/**
 * The private media bucket, server side (§4.2, spec §8).
 *
 * The path is built here and never read from a request body: a media_ref from the client is a
 * claim, not a capability. Every read re-checks the uid segment before the object is touched, so a
 * foreign path costs one string comparison and zero bytes of download.
 *
 * The media_objects row is written at SIGN time with the DECLARED size, so an abandoned capture is
 * still visible to the 24-hour sweep even if the upload never completes.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignRequest, SignResponse } from "@/lib/capture/types";
import { HttpError } from "@/lib/server/auth";

export const MEDIA_BUCKET = "media";
export const SIGNED_UPLOAD_SECONDS = 60;
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

export function objectKey(path: string): string {
  return path.startsWith(`${MEDIA_BUCKET}/`) ? path.slice(MEDIA_BUCKET.length + 1) : path;
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
  return { path, uploadUrl: signed.data.signedUrl, expiresInSeconds: SIGNED_UPLOAD_SECONDS };
}

export async function fetchOwnedObject(
  admin: SupabaseClient, userId: string, path: string
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const key = objectKey(path);
  if (key.split("/")[0] !== userId) {
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
