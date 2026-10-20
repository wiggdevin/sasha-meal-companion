"use client";

import { useSyncExternalStore } from "react";
import { assertCurrent, currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { COMPANIONS_HIDDEN_CAP, companionKeysOf, storedCompanionKeysOf, type MascotKey } from "@/lib/profile/mascot";
import { loadStore, saveStoreFor } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { announceQueued, mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { opKind, SETTINGS_ENTITY } from "@/lib/sync/settings-intents";

/**
 * Which companions the account shows on Today (UI makeover W3, docs/plans/2026-10-19-ui-makeover.md
 * §5). Every companion is shown until the person hides it; the list is `Settings.companionsHidden`,
 * synced per account as `user_settings.companions_hidden`. A hidden companion draws nothing on Today,
 * mounts no care layer (no Seeds read, notes or awards) and stands in no tour.
 */

/** Fired after this phone shows or hides a companion, so every reader redraws at once. */
export const COMPANION_VISIBILITY_EVENT = "companion-visibility-changed";

/** The hidden keys a settings blob holds, known keys only, each once. */
export const hiddenCompanions = (settings: { companionsHidden?: readonly unknown[] | null }): MascotKey[] =>
  companionKeysOf(settings.companionsHidden ?? []);

/** The list with `key` shown or hidden; the order of the others (unknown keys too) is kept. */
export function withCompanionShown(hidden: readonly string[], key: MascotKey, shown: boolean): string[] {
  const rest = hidden.filter((k) => k !== key);
  return shown ? rest : [...rest, key];
}

// The settings live in a JSON blob that loadStore parses on every call: read once, and again only
// after a sync pass, a local change, or a new subscriber.
let cached: MascotKey[] | null = null;
const snapshot = (): MascotKey[] => (cached ??= hiddenCompanions(loadStore().settings));
function subscribe(onChange: () => void): () => void {
  cached = null;
  const fresh = () => { cached = null; onChange(); };
  window.addEventListener(SYNCED_EVENT, fresh);
  window.addEventListener(COMPANION_VISIBILITY_EVENT, fresh);
  return () => {
    window.removeEventListener(SYNCED_EVENT, fresh);
    window.removeEventListener(COMPANION_VISIBILITY_EVENT, fresh);
  };
}

/** Whether this companion is shown. The snapshot is a boolean, so it is stable between reads. */
export function useCompanionShown(key: MascotKey): boolean {
  return useSyncExternalStore(subscribe, () => !snapshot().includes(key), () => true);
}

/** The hidden list itself (Settings' "Hidden" tags); the same array until it changes. */
export function useHiddenCompanions(): readonly MascotKey[] {
  return useSyncExternalStore(subscribe, snapshot, () => NONE);
}
const NONE: readonly MascotKey[] = [];

// One queue for every companion write on this phone (the choice in Settings and Show/Hide alike):
// each is sent after the one before it, in tap order, so an older answer never lands last.
let queue: Promise<unknown> = Promise.resolve();
export function enqueueCompanionWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => {}).then(task);
  queue = run;
  return run;
}

// Writes keep every stored key, a newer companion this phone does not know included.
function saveHidden(h: AccountHandle, change: (hidden: string[]) => string[]): void {
  const store = loadStore();
  const companionsHidden = storedCompanionKeysOf(change(storedCompanionKeysOf(store.settings.companionsHidden)));
  saveStoreFor(h, { ...store, settings: { ...store.settings, companionsHidden } }, { silent: true });
  window.dispatchEvent(new Event(COMPANION_VISIBILITY_EVENT));
}

/** Thrown when hiding would pass the database's cap of 8 hidden keys: the hide is refused, never
 *  silently dropped. */
export class CompanionsHiddenFull extends Error {
  constructor() { super("companions_hidden_full"); this.name = "CompanionsHiddenFull"; }
}

/**
 * The one writer of `companions_hidden`: this key's change laid onto the account's mirrored row,
 * every other key (a newer companion this phone does not know included) kept. The settings intent
 * records it as a set delta, so a replay after another phone's change moves only this key. Tells
 * the sync loop there is something to send.
 */
export async function writeCompanionShown(h: AccountHandle, key: MascotKey, shown: boolean): Promise<void> {
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    const { rev: _rev, user_id: _userId, ...stored } = row;
    void _rev; void _userId;
    const next = withCompanionShown(storedCompanionKeysOf(row.companions_hidden), key, shown);
    if (next.length > COMPANIONS_HIDDEN_CAP) throw new CompanionsHiddenFull();
    const payload = { ...stored, companions_hidden: next };
    return {
      row: { ...row, ...payload },
      op: { op_id: crypto.randomUUID(), entity: SETTINGS_ENTITY, entity_id: USER_SETTINGS_KEY,
        kind: opKind(rev), base_rev: rev, payload, client_ts: new Date().toISOString() },
      result: undefined,
    };
  });
  announceQueued();
}

/**
 * Shows or hides one companion for the signed-in account. The phone changes at once; the write is
 * queued behind any other companion write and applies only this key, on the mirrored row as it is
 * when its turn comes (a pull in between is kept). If it fails, only this key goes back (a later
 * tap on another companion stands), and the error is thrown for the caller's feedback. A write is
 * bound to the account signed in at the tap: after a switch it is neither sent nor rolled back into
 * the next account.
 */
export async function setCompanionShown(key: MascotKey, shown: boolean, deps: {
  h?: AccountHandle | null; write?: typeof writeCompanionShown;
} = {}): Promise<void> {
  const h = deps.h === undefined ? currentAccountOrNull() : deps.h;
  const write = deps.write ?? writeCompanionShown;
  if (!h) throw new Error("No account is signed in.");
  assertCurrent(h);
  const before = !storedCompanionKeysOf(loadStore().settings.companionsHidden).includes(key);
  saveHidden(h, (hidden) => withCompanionShown(hidden, key, shown));
  await enqueueCompanionWrite(async () => {
    try {
      assertCurrent(h);
      await write(h, key, shown);
    } catch (error) {
      try {
        assertCurrent(h);
        saveHidden(h, (hidden) => withCompanionShown(hidden, key, before));
      } catch { /* another account is signed in now: nothing of this one is touched */ }
      throw error;
    }
    // A pull that landed while this waited its turn may have put the old list back on the phone.
    try { assertCurrent(h); saveHidden(h, (hidden) => withCompanionShown(hidden, key, shown)); } catch { /* switched */ }
  });
}
