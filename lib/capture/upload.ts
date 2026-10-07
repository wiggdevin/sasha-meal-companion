/**
 * The PUT half of a capture upload: the bytes go straight to the storage URL the sign route handed
 * back. Kept apart from lib/capture-client.ts because it is not an app route: it carries no account
 * header (the signed URL is the capability, and an extra header would change the storage request).
 */
import { fetchWithDeadline } from "@/lib/fetch-with-deadline";

/** Null when the upload landed; otherwise the status to report (0 when nothing answered). */
export async function putSignedUpload(
  uploadUrl: string, blob: Blob, fetchFn: typeof fetch, signal?: AbortSignal,
): Promise<number | null> {
  try {
    const put = await fetchWithDeadline("upload", uploadUrl, {
      method: "PUT", headers: { "content-type": blob.type }, body: blob,
      ...(signal ? { signal } : {}),
    }, { fetchImpl: fetchFn });
    return put.ok ? null : put.status;
  } catch {
    // An upload that ran out of time and one that never connected are the same retry for the user.
    return 0;
  }
}
