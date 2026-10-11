/**
 * Audit 2026-10-10 A078: starring a food again after its unstar synced was silently dropped.
 *
 * The synced unstar leaves the server row tombstoned, and the pull of that delete (`current: null`)
 * removes the local row, so the next star is a `create`. The server refuses a create on a row it
 * holds, the conflict merge let the tombstone dominate, the rebased `update` answered `deleted`, and
 * the star vanished from every device. The re-star must land as a restore.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listFavorites, setFavorite } from "@/lib/favorites-client";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { allOps, getRow } from "@/lib/sync/idb";
import { defaultStore, saveStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import { FakeSyncServer } from "@/tests/helpers/fake-sync-server";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

const REF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let h: AccountHandle;
let server: FakeSyncServer;

async function pass(): Promise<void> {
  await pullChanges(h, undefined, { fetchFn: server.fetch });
  await pushOutbox(h, { fetchFn: server.fetch });
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  saveStore(defaultStore());
  server = new FakeSyncServer();
});

describe("starring a food again after its unstar synced", () => {
  it("restores the server's row instead of losing the star", async () => {
    await setFavorite("food", REF, true, { name: "Rice" }, h);
    await pass();
    await setFavorite("food", REF, false, undefined, h);
    await pass();
    // The pull of that delete took the local row away.
    await pass();
    expect(await getRow(h, "favorites_foods", REF)).toBeUndefined();
    expect(server.row("favorites_foods", REF)?.deleted_at).toBeTruthy();

    // The second tap: a create, which the server refuses because it still holds the tombstone.
    expect(await setFavorite("food", REF, true, { name: "Rice" }, h)).toBe(true);
    await pass(); // conflict, re-aimed
    await pass(); // the re-aimed op lands

    expect(server.row("favorites_foods", REF)).toMatchObject({ deleted_at: null, rev: 3 });
    expect(await allOps(h)).toEqual([]);
    expect((await listFavorites()).map((row) => row.id)).toEqual([REF]);
  });

  it("re-aims the refused create as a restore at the server's revision", async () => {
    await setFavorite("food", REF, true, { name: "Rice" }, h);
    await pass();
    await setFavorite("food", REF, false, undefined, h);
    await pass();
    await pass();
    await setFavorite("food", REF, true, undefined, h);
    await pass();

    const [op] = await allOps(h);
    expect(op).toMatchObject({ entity: "favorites_foods", entity_id: REF, kind: "restore",
      base_rev: 2 });
    // Starred on this phone while the restore is on its way.
    expect(await getRow(h, "favorites_foods", REF)).toMatchObject({ deleted_at: null, rev: 2 });
  });
});
