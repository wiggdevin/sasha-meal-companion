/**
 * PR #248 review r6 #3 and #6.
 *  - #3: adopting legacy pending records merges under the SAME lock the pending writers use, in one
 *    IndexedDB transaction, so a weigh-in another writer parks meanwhile is never overwritten.
 *  - #6: a legacy check that failed is not "no legacy data": the adopted marker is not written, so
 *    a later run still copies the account's owned rows.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { adoptLegacyDevice } from "@/lib/device/legacy-adoption";
import { __resetWeighInDrain, readPendingWeighIns, withWeighInLock } from "@/lib/health/weigh-in-client";
import { closeAllAccountDbs, getRow, putMeta, upgradeStores } from "@/lib/sync/idb";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function seed(): Promise<void> {
  const db = await openDB("smc", 4, { upgrade: upgradeStores });
  await db.put("plan_days", { local_date: "2026-09-01", user_id: A, rev: 3 }, "2026-09-01");
  await db.put("meta", [{ userId: A, request: { localDate: "2026-09-20", lb: 150, tz: "UTC" } }],
    "pending_weigh_ins");
  db.close();
}

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  globalThis.indexedDB = new IDBFactory();
  const cells = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => cells.get(k) ?? null,
    setItem: (k: string, v: string) => { cells.set(k, v); },
    removeItem: (k: string) => { cells.delete(k); },
    key: (i: number) => [...cells.keys()][i] ?? null,
    get length() { return cells.size; },
  });
  __resetWeighInDrain();
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("legacy adoption and the pending writers", () => {
  it("keeps a weigh-in another writer parks while adoption merges the legacy one", async () => {
    await seed();
    const a = bindAccount(A);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    // Another writer, inside the weigh-in lock: reads the list, then writes its record later.
    const writer = withWeighInLock(async () => {
      const before = await readPendingWeighIns(a);
      await gate;
      await putMeta(a, "pending_weigh_ins", [...before,
        { userId: A, request: { localDate: "2026-09-21", lb: 151, tz: "UTC" } }]);
    });
    const adopting = adoptLegacyDevice(a);
    await new Promise((r) => setTimeout(r, 30));
    open();
    await Promise.all([writer, adopting]);
    const days = (await readPendingWeighIns(a)).map((e) => e.request.localDate).sort();
    expect(days).toEqual(["2026-09-20", "2026-09-21"]);
  });
});

describe("a failed legacy check", () => {
  it("writes no adopted marker, so a later run still copies the owned rows", async () => {
    await seed();
    const a = bindAccount(A);
    const real = indexedDB.databases.bind(indexedDB);
    const spy = vi.spyOn(indexedDB, "databases").mockRejectedValueOnce(new Error("busy"));
    await adoptLegacyDevice(a);
    expect(localStorage.getItem(`smc:device:legacy-adopted:${A}`)).toBeNull();
    spy.mockImplementation(real);
    await adoptLegacyDevice(a);
    expect(await getRow(a, "plan_days", "2026-09-01")).toMatchObject({ user_id: A });
  });
});
