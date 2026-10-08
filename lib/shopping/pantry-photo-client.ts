"use client";
/**
 * The phone half of W12 "pantry from a photo" (docs/specs/phase-18-open-world-foods.md §W12,
 * backend contract: CONTRACT W12 in the coordination board). Mirrors the shape of
 * lib/plan/inspire-client.ts's own photo helpers: `PhotoCapture` already resizes on-device
 * (lib/media/resize.ts, EXIF dropped) before handing back a Blob, so nothing here resizes a
 * second time — it only uploads what it is given, same as lib/capture-client.ts's captureMedia.
 *
 * Draft, then confirm-first write (acceptance 1, 2): `draftPantryPhoto` writes nothing; only
 * `confirmPantryPhoto` does, and only for the items the user kept after editing the draft.
 */
import { signAndUpload } from "@/lib/capture-client";
import { AccountChanged, accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import { withRuleMarks } from "@/lib/shopping/rule-mark-wire";
import type { PantryItem } from "@/lib/shopping/types";

export class PantryPhotoError extends Error {}

/** One item the confirm batch could not write (lib/server/pantry-photo.ts FailedPantryPhotoItem) --
 *  surfaced to the user, never silently dropped (acceptance 3). */
export type FailedPantryPhotoItem = { name: string; status: number; code: string; message: string };
export type PantryPhotoConfirmItem = { name: string; grams: number | null };

async function post<T>(h: AccountHandle, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await accountFetch(h, path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }, { budget: "commit" });
  } catch (e) {
    if (e instanceof AccountChanged) throw e;
    throw new PantryPhotoError("That took too long. Try again.");
  }
  const json = await accountJson<{ message?: string } & Partial<T>>(h, res).catch(() => null);
  if (!res.ok || !json) throw new PantryPhotoError((json as { message?: string } | null)?.message ?? "Couldn’t read that. Try again.");
  return json as T;
}

/** Uploads an ALREADY-RESIZED photo (the Blob `PhotoCapture`'s `onReady` hands back) through the
 *  shared media pipeline; returns the server's own path for the later draft request. */
export async function uploadPantryPhoto(h: AccountHandle, photo: Blob): Promise<string> {
  const uploaded = await signAndUpload("image", photo, fetch, { account: h });
  if (uploaded.kind === "failed") throw new PantryPhotoError(uploaded.outcome.message);
  return uploaded.path;
}

/** The draft step (acceptance 1): ingredient names only, nothing written yet. */
export async function draftPantryPhoto(h: AccountHandle, mediaPath: string): Promise<string[]> {
  const result = await post<{ items: string[] }>(h, "/api/pantry/photo", { mediaPath });
  return result.items;
}

/** The confirm step (acceptance 2, 3): writes one row per kept item; `failed` is never discarded
 *  into the caller's error path -- a 3-of-5 failure still returns the other 2 as `items`. */
export async function confirmPantryPhoto(
  h: AccountHandle, requestId: string, items: readonly PantryPhotoConfirmItem[],
): Promise<{ items: PantryItem[]; failed: FailedPantryPhotoItem[] }> {
  const result = await post<{ items: PantryItem[]; failed: FailedPantryPhotoItem[] }>(
    h, "/api/pantry/photo/confirm", { requestId, items });
  return { items: withRuleMarks(result.items), failed: result.failed ?? [] };
}
