/**
 * The records behind deferred picked logs (lib/log/picked-deferred.ts): one `meta` value per entry,
 * `deferred_pick:<entryId>`, in this account's own IndexedDB. Its own module, with no commit
 * import, because Today's states and the delete path read it and the commit path imports both.
 */
import { assertCurrent, rethrowAccountChanged, type AccountHandle } from "@/lib/device/account";
import type { LogPick } from "@/lib/log/picked-commit";
import { deleteMeta, getMeta, META_STORE, openAccountDb } from "@/lib/sync/idb";
import type { LoggedFood, SlotId } from "@/lib/types";

const KEY_PREFIX = "deferred_pick:";

/** One deferred entry: everything needed to rebuild its commit, and the card Today shows for it. */
export type DeferredPickedCommit = {
  entryId: string;
  userId: string;
  picks: LogPick[];
  slot: SlotId;
  meal?: { name: string; note: string };
  /** The tap's instant (ISO) and zone: the commit files the entry where the tap filed the card. */
  at: string;
  tz: string;
  localDate: string;
  card: LoggedFood;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
  /**
   * The server refused the commit (t17 round 2). The record and the card both stay — the card as a
   * local one marked `notSaved` — and no drain sends it again until `retryDeferred` clears this.
   */
  refused?: { status: string; reason: string; at: string };
};

export function deferredKey(entryId: string): string {
  return `${KEY_PREFIX}${entryId}`;
}

/** The record for this entry, if one is waiting. Throws only for an account change. */
export async function readDeferred(
  h: AccountHandle, entryId: string,
): Promise<DeferredPickedCommit | undefined> {
  return getMeta<DeferredPickedCommit>(h, deferredKey(entryId));
}

/** Every record this account has waiting, oldest first. A database that cannot be read has none. */
export async function readAllDeferred(h: AccountHandle): Promise<DeferredPickedCommit[]> {
  try {
    const db = await openAccountDb(h);
    const keys = (await db.getAllKeys(META_STORE))
      .filter((k): k is string => typeof k === "string" && k.startsWith(KEY_PREFIX));
    const rows = await Promise.all(keys.map((k) => db.get(META_STORE, k)));
    // A read that started as one account and finished after another bound belongs to nobody.
    assertCurrent(h);
    return (rows as (DeferredPickedCommit | undefined)[])
      .filter((r): r is DeferredPickedCommit => r !== undefined && r.userId === h.userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (e) {
    rethrowAccountChanged(e);
    return [];
  }
}

/** The ids Today draws as pending: a deferred entry is a save still on its way. A refused one is
 *  not on its way; it is listed by `refusedDeferred` instead. */
export async function deferredEntryIds(h: AccountHandle): Promise<string[]> {
  return (await readAllDeferred(h)).filter((r) => !r.refused).map((r) => r.entryId);
}

/** Every deferred log the server refused: the card's id, its day and the reason to show. */
export async function refusedDeferred(
  h: AccountHandle,
): Promise<{ entryId: string; localDate: string; status: string; reason: string }[]> {
  return (await readAllDeferred(h)).flatMap((r) => (r.refused
    ? [{ entryId: r.entryId, localDate: r.localDate, ...r.refused }] : []));
}

/**
 * The user deleted the card. The record goes, so no drain sends it. True when there was one;
 * `"unreadable"` when the database could not say (the caller then treats the entry as possibly sent).
 */
export async function forgetDeferred(
  h: AccountHandle, entryId: string,
): Promise<boolean | "unreadable"> {
  try {
    const had = await readDeferred(h, entryId);
    if (had === undefined) return false;
    await deleteMeta(h, deferredKey(entryId));
    return true;
  } catch (e) {
    rethrowAccountChanged(e);
    return "unreadable";
  }
}

