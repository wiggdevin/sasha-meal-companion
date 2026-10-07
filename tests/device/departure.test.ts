// @vitest-environment jsdom
/**
 * Phase 9 slice 1, reload boundary (replaces the in-place switch of PR #248; review r7 BLOCK 1/2).
 *
 * Leaving an account freezes it synchronously, makes its state durable under its own keys, and
 * only then signs out and reloads. Every "new page" here is a real one: `vi.resetModules()` drops
 * all module state, as a reload does, while localStorage and IndexedDB stay.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "2026-09-22";
const STORE_A = `smc:u:${A}:store`;

type Page = {
  account: typeof import("@/lib/device/account");
  departure: typeof import("@/lib/device/departure");
  boot: typeof import("@/lib/device/boot");
  store: typeof import("@/lib/store");
  idb: typeof import("@/lib/sync/idb");
  reload: ReturnType<typeof vi.fn<() => void>>;
};

/** A fresh document: fresh modules, the same localStorage and IndexedDB. */
async function newPage(): Promise<Page> {
  vi.resetModules();
  const page = {
    account: await import("@/lib/device/account"),
    departure: await import("@/lib/device/departure"),
    boot: await import("@/lib/device/boot"),
    store: await import("@/lib/store"),
    idb: await import("@/lib/sync/idb"),
    reload: vi.fn<() => void>(),
  };
  page.departure.__setDepartureDeps({ reload: page.reload });
  return page;
}

const extra = (id: string) => ({ id, name: id, kcal: 100 }) as never;
const extraIds = (s: { days: Record<string, { extras?: { id: string }[] }> }) =>
  s.days[DATE]?.extras?.map((e) => e.id) ?? [];
const op = (id: string) => ({ op_id: id, entity: "water_log" as const, entity_id: DATE,
  kind: "update" as const, base_rev: 1, payload: { local_date: DATE, cups: 1 },
  client_ts: "2026-09-22T08:00:00Z" });

/** localStorage refuses A's store key (quota) until `recover()`. */
function refuseStoreWrites(): { recover: () => void } {
  const real = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage, key: string, value: string,
  ) {
    if (key === STORE_A) throw new DOMException("full", "QuotaExceededError");
    return real.call(this, key, value);
  });
  return { recover: () => spy.mockRestore() };
}

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("the freeze", () => {
  it("closes at once (no new work, sync stopped), then freezes A before any persist", async () => {
    const page = await newPage();
    const a = page.account.bindAccount(A);
    page.account.markAccountReady(a);
    const gone = vi.fn();
    page.account.onAccountGone(gone);
    const leaving = page.departure.beginDeparture();
    // Synchronously: the gate and sync close, and no new work can start.
    expect(gone).toHaveBeenCalledWith(expect.objectContaining({ userId: A }));
    expect(page.account.isAccountReady()).toBe(false);
    expect(page.departure.departurePhase()).toBe("leaving");
    expect(() => page.account.accountHandle()).toThrow(page.account.AccountChanged);
    await leaving;
    // Then frozen: every handle is stale and a late save is refused, not silently dropped.
    expect(page.account.isCurrent(a)).toBe(false);
    expect(() => page.store.addExtra(DATE, extra("late"))).toThrow(page.account.AccountChanged);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("work A already started finishes before the freeze: the outbox row and Today's projection land together (reload r1 #2)", async () => {
    const page = await newPage();
    page.account.bindAccount(A);
    const { savePlanDay } = await import("@/lib/plan-day-client");
    const saving = savePlanDay(DATE, { floorDay: true });
    const leaving = page.departure.beginDeparture();
    await expect(saving).resolves.toMatchObject({ date: DATE, floorDay: true });
    await leaving;
    const pageA2 = await newPage();
    const a2 = pageA2.account.bindAccount(A);
    expect((await pageA2.idb.allOps(a2)).map((o) => o.entity)).toEqual(["plan_days"]);
    expect(pageA2.store.loadStore().days[DATE]).toMatchObject({ floorDay: true });
  });

  it("an account change elsewhere never binds the next account in this page", async () => {
    const page = await newPage();
    expect(page.boot.applySessionAccount(A)).toBe("bound");
    const a = page.account.accountHandle();
    expect(page.boot.applySessionAccount(B)).toBe("departing");
    expect(page.account.currentAccountOrNull()?.userId).not.toBe(B);
    await vi.waitFor(() => expect(page.reload).toHaveBeenCalledTimes(1));
    expect(page.account.isCurrent(a)).toBe(false);
    expect(page.account.currentAccountOrNull()).toBeNull();
    // Even the same account cannot come back in this page: only a new page binds.
    expect(page.boot.applySessionAccount(A)).toBe("departing");
    expect(page.account.currentAccountOrNull()).toBeNull();
  });
});

describe("A's data across new pages (A → B → A)", () => {
  it("A's saved store and queued op return only for A; B's page sees none of them, offline too", async () => {
    const pageA = await newPage();
    const a = pageA.account.bindAccount(A);
    pageA.store.addExtra(DATE, extra("a-meal"));
    await pageA.idb.appendOp(a, op("a-op"));
    await pageA.departure.beginDeparture();
    expect(pageA.reload).toHaveBeenCalledTimes(1);

    const fetchSpy = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetchSpy);
    const pageB = await newPage();
    const b = pageB.account.bindAccount(B);
    expect(extraIds(pageB.store.loadStore())).toEqual([]);
    expect(await pageB.idb.allOps(b)).toEqual([]);
    await pageB.departure.beginDeparture();

    const pageA2 = await newPage();
    const a2 = pageA2.account.bindAccount(A);
    expect(extraIds(pageA2.store.loadStore())).toEqual(["a-meal"]);
    expect((await pageA2.idb.allOps(a2)).map((o) => o.op_id)).toEqual(["a-op"]);
    expect(fetchSpy).not.toHaveBeenCalled(); // all of it came from this phone
    vi.unstubAllGlobals();
  });

  it("an edit localStorage refused is written under A's key before the reload, and only A sees it", async () => {
    const pageA = await newPage();
    pageA.account.bindAccount(A);
    const full = refuseStoreWrites();
    pageA.store.addExtra(DATE, extra("unsaved"));
    expect(localStorage.getItem(STORE_A)).toBeNull(); // only in memory
    full.recover();
    await pageA.departure.beginDeparture();
    expect(pageA.reload).toHaveBeenCalledTimes(1);

    const pageB = await newPage();
    pageB.account.bindAccount(B);
    expect(extraIds(pageB.store.loadStore())).toEqual([]);

    const pageA2 = await newPage();
    pageA2.account.bindAccount(A);
    expect(extraIds(pageA2.store.loadStore())).toEqual(["unsaved"]);
  });

  it("the IndexedDB barrier: a transaction A started before the freeze commits before the reload", async () => {
    const page = await newPage();
    const a = page.account.bindAccount(A);
    const db = await page.idb.openAccountDb(a);
    const order: string[] = [];
    page.reload.mockImplementation(() => order.push("reload"));
    const tx = db.transaction("meta", "readwrite");
    void tx.store.put(["queued"], "pending_log_entries");
    void tx.done.then(() => order.push("committed"));
    await page.departure.beginDeparture();
    expect(order).toEqual(["committed", "reload"]);
    const pageA2 = await newPage();
    const a2 = pageA2.account.bindAccount(A);
    expect(await pageA2.idb.getMeta(a2, "pending_log_entries")).toEqual(["queued"]);
  });
});

describe("a store write that cannot be persisted (review r7 BLOCK 1)", () => {
  it("blocks with nothing changed — no sign-out, no reload — and Retry finishes once storage recovers", async () => {
    const page = await newPage();
    page.account.bindAccount(A);
    page.store.addExtra(DATE, extra("before"));
    const full = refuseStoreWrites();
    page.store.addExtra(DATE, extra("unsaved"));
    const signOut = vi.fn(async () => {});
    const leaving = page.departure.beginDeparture({ signOut, announce: true });
    // Accepted while closing (work that was already running): kept with the unsaved edit.
    page.store.addExtra(DATE, extra("while-closing"));
    expect(await leaving).toBe("blocked");
    expect(page.departure.departurePhase()).toBe("blocked");
    expect(signOut).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
    expect(extraIds(JSON.parse(localStorage.getItem(STORE_A)!))).toEqual(["before"]);
    // After the freeze a write is refused where it happens, never kept in memory to be lost.
    expect(() => page.store.addExtra(DATE, extra("after-freeze"))).toThrow(page.account.AccountChanged);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("smc:u:") && k !== STORE_A)).toEqual([]);

    // Still full: Retry blocks again, and still nothing changes.
    expect(await page.departure.retryDeparture()).toBe("blocked");
    expect(signOut).not.toHaveBeenCalled();

    full.recover();
    expect(await page.departure.retryDeparture()).toBe("leaving");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(extraIds(JSON.parse(localStorage.getItem(STORE_A)!)))
      .toEqual(["before", "unsaved", "while-closing"]);
  });

  it("a sign-out that cannot remove the session blocks too, after the state is durable", async () => {
    const page = await newPage();
    page.account.bindAccount(A);
    const signOut = vi.fn<() => Promise<void>>(async () => { throw new Error("session_not_removed"); });
    expect(await page.departure.beginDeparture({ signOut })).toBe("blocked");
    expect(page.reload).not.toHaveBeenCalled();
    signOut.mockResolvedValue(undefined);
    expect(await page.departure.retryDeparture()).toBe("leaving");
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("a barrier that never answers blocks with Retry; no sign-out, no reload (reload r2 #5)", async () => {
    vi.doMock("@/lib/sync/idb", async (orig) => ({
      ...(await orig<typeof import("@/lib/sync/idb")>()),
      settleAccountDb: () => new Promise<void>(() => {}),
    }));
    try {
      const page = await newPage();
      page.departure.__setDepartureDeps({ reload: page.reload, quietMs: 40, settleMs: 40 });
      page.account.bindAccount(A);
      const signOut = vi.fn(async () => {});
      expect(await page.departure.beginDeparture({ signOut })).toBe("blocked");
      expect(signOut).not.toHaveBeenCalled();
      expect(page.reload).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/lib/sync/idb");
    }
  });
});
