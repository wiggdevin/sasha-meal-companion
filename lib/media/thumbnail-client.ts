/**
 * The phone half of a plate photo's kept thumbnail (W125, T2 D2): one signed read URL per entry,
 * from GET /api/media/thumbnail, held in memory for a little less than its hour. "None" is held
 * for 30 seconds only, since a just-saved capture links its thumbnail when its commit lands. Any failure shows no picture and
 * is asked again next time; a card never waits on it.
 */
import { useEffect, useState } from "react";
import { captureMetaFrom } from "@/lib/capture-client";
import { accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import { getRow } from "@/lib/sync/idb";

const THUMBNAIL_URL = "/api/media/thumbnail";
/** Five minutes short of the server's hour, so a held URL never expires on screen. */
const HOLD_MS = 55 * 60_000;
/** "No picture yet" is held briefly: a fresh capture's commit links its thumbnail a moment later. */
const NONE_HOLD_MS = 30_000;

type Held = { url: string | null; until: number };
const held = new Map<string, Held>();
const inFlight = new Map<string, Promise<string | null>>();

/** Forget every held URL (an account change; tests). */
export function resetThumbnailCache(): void {
  held.clear();
  inFlight.clear();
}

export async function entryThumbnailUrl(
  entryId: string, opts: { account?: AccountHandle; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now;
  let h: AccountHandle;
  try { h = opts.account ?? accountHandle(); } catch { return null; } // signed out or switching
  const key = `${h.userId}:${entryId}`;
  const hit = held.get(key);
  if (hit && hit.until > now()) return hit.url;
  const running = inFlight.get(key);
  if (running) return running;
  const work = (async () => {
    try {
      const res = await accountFetch(h, `${THUMBNAIL_URL}?entry=${encodeURIComponent(entryId)}`,
        { headers: { accept: "application/json" } }, { budget: "search", fetchImpl: opts.fetchImpl });
      if (!res.ok) return null;
      const body = await accountJson<{ url?: unknown }>(h, res);
      const url = typeof body.url === "string" && body.url.startsWith("https://") ? body.url : null;
      held.set(key, { url, until: now() + (url === null ? NONE_HOLD_MS : HOLD_MS) });
      return url;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, work);
  return work;
}

/** The entry's thumbnail URL, or null. `entryId` null asks nothing (not a plate photo). */
export function useEntryThumbnail(entryId: string | null): string | null {
  const [found, setFound] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (entryId === null) return;
    let live = true;
    void entryThumbnailUrl(entryId).catch(() => null)
      .then((url) => { if (live) setFound({ id: entryId, url }); });
    return () => { live = false; };
  }, [entryId]);
  // A URL found for another entry is never shown for this one.
  return found !== null && found.id === entryId ? found.url : null;
}

/** Whether the mirrored entry row says it came from a plate photo; false when nothing can tell. */
async function isPhotoEntry(entryId: string): Promise<boolean> {
  try {
    const row = await getRow(accountHandle(), "log_entries", entryId);
    return captureMetaFrom(row)?.method === "photo";
  } catch {
    return false;
  }
}

/** The entry sheet's photo: reads the entry's own capture method first, then its thumbnail. */
export function useEntryPhoto(entryId: string | null): string | null {
  const [photo, setPhoto] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (entryId === null) return;
    let live = true;
    void isPhotoEntry(entryId).then((yes) => { if (live && yes) setPhoto({ id: entryId }); });
    return () => { live = false; };
  }, [entryId]);
  return useEntryThumbnail(photo !== null && photo.id === entryId ? entryId : null);
}
