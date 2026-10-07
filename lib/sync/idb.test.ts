import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import {
  accountDbName, allOps, allRows, appendOp, CATALOG_STORE, closeAllAccountDbs, countOps, DB_VERSION,
  deleteOp, deleteRow, getCursor, getLastSyncAt, getMeta, getRow, openAccountDb, putRow, setCursor,
  setLastSyncAt,
} from "./idb";
import { ENTITIES, type SyncOp } from "./types";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function op(id: string): SyncOp {
  return {
    op_id: id, entity: "water_log", entity_id: "2026-09-11", kind: "update",
    base_rev: 1, payload: { cups: 1 }, client_ts: "2026-09-11T10:00:00.000Z",
  };
}

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  globalThis.indexedDB = new IDBFactory();
});

describe("the account database", () => {
  it("opens smc-u-<userId> at version 1 with one store per synced entity plus outbox and meta", async () => {
    const h = bindAccount(A);
    const db = await openAccountDb(h);
    expect([db.name, db.version]).toEqual([accountDbName(A), 1]);
    expect(DB_VERSION).toBe(1);
    for (const store of [...ENTITIES, "outbox", "meta", CATALOG_STORE]) {
      expect([...db.objectStoreNames]).toContain(store);
    }
  });

  it("stores rows by entity_key", async () => {
    const h = bindAccount(A);
    await putRow(h, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 2 });
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toEqual({
      local_date: "2026-09-11", cups: 4, rev: 2,
    });
    await putRow(h, "water_log", "2026-09-12", { local_date: "2026-09-12", cups: 1, rev: 1 });
    expect(await allRows(h, "water_log")).toHaveLength(2);
    await deleteRow(h, "water_log", "2026-09-11");
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toBeUndefined();
  });

  it("appends outbox ops in order and reads them back in order", async () => {
    const h = bindAccount(A);
    await appendOp(h, op("11111111-1111-4111-8111-111111111111"), 1_000);
    await appendOp(h, op("22222222-2222-4222-8222-222222222222"), 2_000);
    const ops = await allOps(h);
    expect(ops.map((o) => o.seq)).toEqual([1, 2]);
    expect(ops[0]).toMatchObject({
      attempts: 0, next_attempt_at: 1_000, queued_at: new Date(1_000).toISOString(),
    });
    expect(await countOps(h)).toBe(2);
    await deleteOp(h, ops[0].op_id);
    expect((await allOps(h)).map((o) => o.seq)).toEqual([2]);
  });

  it("starts the cursor at 0 and remembers what it is told", async () => {
    const h = bindAccount(A);
    await expect(getCursor(h)).resolves.toBe(0);
    await setCursor(h, 42);
    await expect(getCursor(h)).resolves.toBe(42);
    await expect(getLastSyncAt(h)).resolves.toBeNull();
    await setLastSyncAt(h, "2026-09-11T10:00:00.000Z");
    await expect(getLastSyncAt(h)).resolves.toBe("2026-09-11T10:00:00.000Z");
  });

  it("carries a store for each phase 3 and phase 6 entity", async () => {
    const db = await openAccountDb(bindAccount(A));
    for (const store of ["recipes", "favorites_foods", "favorites_recipes", "favorites_meals",
      "target_profiles", "target_proposals"]) {
      expect(db.objectStoreNames.contains(store)).toBe(true);
    }
  });
});

describe("per-account isolation (Phase 9 §0.2)", () => {
  it("keeps A's rows out of B's database", async () => {
    const a = bindAccount(A);
    await putRow(a, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, user_id: A });
    const b = bindAccount(B);
    await expect(getRow(b, "water_log", "2026-09-11")).resolves.toBeUndefined();
  });

  it("refuses a write with a stale handle and writes nothing", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    await expect(putRow(a, "water_log", "d", { cups: 1 })).rejects.toBeInstanceOf(AccountChanged);
    unbindAccount();
    const a2 = bindAccount(A);
    await expect(getRow(a2, "water_log", "d")).resolves.toBeUndefined();
  });

  it("refuses a read with a stale handle", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    await expect(getCursor(a)).rejects.toBeInstanceOf(AccountChanged);
  });

  it("drops a read that was pending when the account changed (audit plan r2 finding 7)", async () => {
    const a = bindAccount(A);
    await putRow(a, "water_log", "d", { local_date: "d", cups: 3, user_id: A });
    await openAccountDb(a);
    const pendingRow = getRow(a, "water_log", "d");
    const pendingAll = allRows(a, "water_log");
    const pendingMeta = getMeta(a, "cursor");
    bindAccount(B);
    await expect(pendingRow).rejects.toBeInstanceOf(AccountChanged);
    await expect(pendingAll).rejects.toBeInstanceOf(AccountChanged);
    await expect(pendingMeta).rejects.toBeInstanceOf(AccountChanged);
  });

  it("stamps user_id on every appended op", async () => {
    const h = bindAccount(A);
    await appendOp(h, op("o1"));
    expect((await allOps(h))[0]).toMatchObject({ op_id: "o1", user_id: A });
  });

  it("refuses an append with a stale handle and queues nothing", async () => {
    const a = bindAccount(A);
    await openAccountDb(a);
    bindAccount(B);
    await expect(appendOp(a, op("o1"))).rejects.toBeInstanceOf(AccountChanged);
    unbindAccount();
    expect(await allOps(bindAccount(A))).toEqual([]);
  });

  it("does not save a cursor for a handle that went stale mid-pass", async () => {
    const a = bindAccount(A);
    await setCursor(a, 5);
    bindAccount(B);
    await expect(setCursor(a, 9)).rejects.toBeInstanceOf(AccountChanged);
    unbindAccount();
    await expect(getCursor(bindAccount(A))).resolves.toBe(5);
  });

  it("does not cache a failed open", async () => {
    const h = bindAccount(A);
    const real = globalThis.indexedDB;
    globalThis.indexedDB = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
    await expect(openAccountDb(h)).rejects.toThrow("blocked");
    globalThis.indexedDB = real;
    await expect(openAccountDb(h)).resolves.toBeTruthy();
  });
});
