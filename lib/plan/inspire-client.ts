"use client";
/**
 * The phone half of "start from a photo or a link": resize and upload a photo through the shared
 * media pipeline (same bucket, same 24 h sweep), then ask the server what it shows.
 */
import { signAndUpload } from "@/lib/capture-client";
import { AccountChanged, accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import { resizeImage } from "@/lib/media/resize";
import type { InspireRequest, InspireResult, PhotoRead } from "@/lib/plan/inspire-types";

export class InspireError extends Error {}

async function post(h: AccountHandle, body: InspireRequest): Promise<InspireResult> {
  let res: Response;
  try {
    res = await accountFetch(h, "/api/plan/inspire", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }, { budget: "propose" });
  } catch (e) {
    if (e instanceof AccountChanged) throw e;
    throw new InspireError("That took too long. Try again.");
  }
  const json = await accountJson<InspireResult & { message?: string }>(h, res).catch(() => null);
  if (!res.ok || !json) throw new InspireError(json?.message ?? "Couldn’t read that. Try again.");
  return json;
}

/** The resized photo and the server's own path for it: kept so a re-read never re-uploads. */
export type UploadedPhoto = { image: Blob; mediaPath: string };

export async function uploadPlanPhoto(h: AccountHandle, file: Blob): Promise<UploadedPhoto> {
  let image: Blob;
  try { image = await resizeImage(file); }
  catch { throw new InspireError("That photo couldn’t be opened. Try a JPEG or PNG."); }
  const uploaded = await signAndUpload("image", image, fetch, { account: h });
  if (uploaded.kind === "failed") throw new InspireError(uploaded.outcome.message);
  return { image, mediaPath: uploaded.path };
}

/** Ask what an uploaded photo shows; `as` re-reads it one way ("Not right?"). */
export function readPlanPhoto(h: AccountHandle, mediaPath: string, localDate: string,
  opts: { as?: PhotoRead; targetKcal?: number } = {}): Promise<InspireResult> {
  const targetKcal = opts.targetKcal && opts.targetKcal >= 100 && opts.targetKcal <= 3000
    ? Math.round(opts.targetKcal) : undefined;
  return post(h, { kind: "photo", mediaPath, localDate, ...(opts.as ? { as: opts.as } : {}),
    ...(targetKcal ? { targetKcal } : {}) });
}

export async function inspireFromPhoto(h: AccountHandle, file: Blob, localDate: string): Promise<InspireResult> {
  const { mediaPath } = await uploadPlanPhoto(h, file);
  return readPlanPhoto(h, mediaPath, localDate);
}

export function inspireFromUrl(h: AccountHandle, url: string, localDate: string): Promise<InspireResult> {
  return post(h, { kind: "url", url: url.trim(), localDate });
}
