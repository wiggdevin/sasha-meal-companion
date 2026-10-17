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
  "smc:device:signal", "smc:device:ground",
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

export function writeAccountItem(h: AccountHandle, name: string, value: string): void {
  assertCurrent(h);
  try {
    storage()?.setItem(accountKey(h, name), value);
  } catch {
    // Full or disabled storage: the value is lost, the caller's work is not.
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
