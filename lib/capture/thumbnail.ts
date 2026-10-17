/**
 * The plate photo's kept thumbnail (W125, T2 D2): its 512 px copy goes up through the same sign
 * and upload as the photo, under the same `media_objects` row and 24-hour sweep, and the commit
 * names its path so the server can link it to the entry (lib/server/log.ts `linkThumbnail`).
 */
import { signAndUpload } from "@/lib/capture-client";
import { rethrowAccountChanged, type AccountHandle } from "@/lib/device/account";

/**
 * Uploads a plate photo's 512 px copy (W125) while the photo is being read, so Save rarely waits
 * (at most a second: CaptureSheet's `settledWithin`). Its path goes on the commit; an unsaved capture's copy is swept with the rest at 24 h.
 * Null on any failure: a meal never fails to log for want of its thumbnail.
 */
export async function uploadThumbnail(
  blob: Blob, fetchFn: typeof fetch = fetch, account?: AccountHandle,
): Promise<string | null> {
  try {
    const uploaded = await signAndUpload("image", blob, fetchFn, account ? { account } : {});
    return uploaded.kind === "uploaded" ? uploaded.path : null;
  } catch (error) {
    rethrowAccountChanged(error);
    return null;
  }
}
