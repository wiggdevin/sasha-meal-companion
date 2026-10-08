/**
 * `localStorage` for one account (Phase 9 §0.4): every value is filed under `smc:u:<id>:<name>`,
 * so an account can only ever read its own. Every helper takes the handle of the work that
 * started it; a write with a stale handle throws `AccountChanged` and writes nothing. A blocked or
 * full storage never throws out of here (private browsing): a read answers null, a write is lost.
 */
import { ACCOUNT_KEY_PREFIX, accountKey, assertCurrent, type AccountHandle } from "./account";

/** Device-level keys: not account data, kept across sign-ins. */
export const DEVICE_KEYS: readonly string[] = [
  "smc:body_capability", "meal-companion:install-prompt-dismissed", "smc:device:accounts",
  "smc:device:signal",
];

export const LEGACY_PREFIX = "smc:legacy:";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readAccountItem(h: AccountHandle, name: string): string | null {
  try {
    return storage()?.getItem(accountKey(h, name)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns whether the value actually landed in storage (#470 followup): a missing, blocked or full
 * store never throws out of here, but it must not look identical to a real write either, or a
 * caller that only checks "did this throw" (`saveWidgetPrefs`, before this fix) reports success for
 * a write that silently went nowhere. `assertCurrent` still throws `AccountChanged` as before — that
 * is the caller's own stale-handle bug, not a storage failure, and is never folded into `false`.
 */
export function writeAccountItem(h: AccountHandle, name: string, value: string): boolean {
  assertCurrent(h);
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(accountKey(h, name), value);
    return true;
  } catch {
    // Full or disabled storage: the value is lost, the caller's work is not.
    return false;
  }
}

export function removeAccountItem(h: AccountHandle, name: string): void {
  try {
    storage()?.removeItem(accountKey(h, name));
  } catch {
    // Nothing to remove from a storage we cannot reach.
  }
}

/** Every key of one account, whatever it is bound to now (for forget). */
export function listAccountKeys(userId: string): string[] {
  const store = storage();
  if (!store) return [];
  const prefix = `${ACCOUNT_KEY_PREFIX}${userId}:`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

/** The names (after `smc:u:<id>:`) of one account's keys that start with `namePrefix`. */
export function accountItemNames(h: AccountHandle, namePrefix: string): string[] {
  const prefix = `${ACCOUNT_KEY_PREFIX}${h.userId}:`;
  return listAccountKeys(h.userId).map((k) => k.slice(prefix.length))
    .filter((name) => name.startsWith(namePrefix));
}
