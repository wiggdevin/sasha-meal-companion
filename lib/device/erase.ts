/**
 * After the server deleted the account: leave it on this phone and erase what it left here.
 *
 * Sign-out keeps an account's data on the phone (lib/device/forget.ts); a deleted account must
 * not. This runs the ordinary departure (lib/device/departure.ts: close, quiet, freeze, settle),
 * and in its last step — after this page's own writes are durable and its database is closed —
 * signs the session out, deletes the account's IndexedDB database, every localStorage key that
 * names the account, and its entry in the device registry. Then the page goes to the sign-in page
 * with `?deleted=1`, which says the account is gone. `announce` tells the account's other tabs to
 * leave first, so none of them holds the database open.
 */
import { currentAccountOrNull } from "./account";
import { listAccountKeys } from "./account-storage";
import { beginDeparture, departurePhase, isDeparting, type DeparturePhase } from "./departure";
import { DEVICE_ACCOUNTS_KEY } from "./forget";
import { accountDbName } from "@/lib/sync/idb";

export const DELETED_LANDING = "/sign-in?deleted=1";

/** The longest the database delete may wait on another tab before the page moves on. */
export const ERASE_DB_BUDGET_MS = 3_000;

type AuthPort = { signOut: (opts?: { scope?: "global" | "local" | "others" }) => Promise<{ error: unknown }> };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Removes every key filed under the account, or naming it, and its device-registry entry. */
export function eraseAccountStorage(userId: string): void {
  const store = storage();
  if (!store) return;
  try {
    const named: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.includes(userId)) named.push(key);
    }
    for (const key of new Set([...listAccountKeys(userId), ...named])) store.removeItem(key);
    const registry = JSON.parse(store.getItem(DEVICE_ACCOUNTS_KEY) ?? "[]") as unknown;
    if (Array.isArray(registry)) {
      store.setItem(DEVICE_ACCOUNTS_KEY, JSON.stringify(
        registry.filter((r) => (r as { userId?: unknown } | null)?.userId !== userId)));
    }
  } catch {
    // Storage we cannot reach holds nothing we could remove.
  }
}

/** Deletes the account's IndexedDB database; resolves after it is gone, blocked, or the budget. */
export function eraseAccountDb(userId: string, budgetMs: number = ERASE_DB_BUDGET_MS): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(); return; }
    const timer = setTimeout(resolve, budgetMs);
    const done = () => { clearTimeout(timer); resolve(); };
    try {
      const request = indexedDB.deleteDatabase(accountDbName(userId));
      request.onsuccess = done;
      request.onerror = done;
      // Another tab still has it open: the delete completes once that tab leaves (announce).
      request.onblocked = done;
    } catch {
      done();
    }
  });
}

/** Signs `userId` out of this phone and erases it here; no-op when the page is on another account. */
export function eraseDeletedAccountHere(auth: AuthPort, userId: string): Promise<DeparturePhase> {
  if (isDeparting() || currentAccountOrNull()?.userId !== userId) return Promise.resolve(departurePhase());
  return beginDeparture({
    announce: true,
    reloadTo: DELETED_LANDING,
    signOut: async () => {
      // The server already revoked every session with the account; this clears this phone's copy.
      // supabase-js removes the local session even when the revoke call fails.
      await auth.signOut({ scope: "local" });
      await eraseAccountDb(userId);
      eraseAccountStorage(userId);
    },
  });
}
