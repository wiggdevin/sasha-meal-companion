/**
 * Devices of one account for sync tests: each its own IndexedDB and its own store (localStorage),
 * swapped in and out of the globals the app reads. Pair with tests/helpers/fake-sync-server.ts.
 */
import { IDBFactory } from "fake-indexeddb";
import { closeAllAccountDbs } from "@/lib/sync/idb";
import { __resetStoreCache } from "@/lib/store";

export type Device = { idb: IDBFactory; window: EventTarget & { localStorage: Storage } };

export function device(): Device {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, String(v)); },
    removeItem: (k: string) => { memory.delete(k); },
  } as Storage;
  return { idb: new IDBFactory(), window: Object.assign(new EventTarget(), { localStorage: storage }) };
}

/** Pick up a device: its own database and its own store. Same account, same server. */
export async function onDevice(d: Device): Promise<void> {
  await closeAllAccountDbs();
  globalThis.indexedDB = d.idb;
  (globalThis as { window?: unknown }).window = d.window;
  __resetStoreCache();
}
