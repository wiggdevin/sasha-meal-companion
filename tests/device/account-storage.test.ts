// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import {
  listAccountKeys, readAccountItem, removeAccountItem, writeAccountItem,
} from "@/lib/device/account-storage";
import { defaultStore, loadStore, resetStoreCache, saveStore, saveStoreFor } from "@/lib/store";
import { readCache, writeCache } from "@/lib/coach-client";
import { fetchDaily } from "@/lib/health-client";
import { fetchExpenditure } from "@/lib/estimator-client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => { localStorage.clear(); unbindAccount(); resetStoreCache(); });

describe("account storage (Phase 9 §0.4)", () => {
  it("namespaces values by account", () => {
    const a = bindAccount(A);
    writeAccountItem(a, "expenditure", "1");
    const b = bindAccount(B);
    expect(readAccountItem(b, "expenditure")).toBeNull();
    expect(listAccountKeys(A)).toEqual([`smc:u:${A}:expenditure`]);
    removeAccountItem(b, "expenditure");
    expect(localStorage.getItem(`smc:u:${A}:expenditure`)).toBe("1");
  });

  it("refuses a write with a stale handle", () => {
    const a = bindAccount(A);
    bindAccount(B);
    expect(() => writeAccountItem(a, "x", "1")).toThrow(AccountChanged);
    expect(localStorage.getItem(`smc:u:${A}:x`)).toBeNull();
  });

  it("keeps A's coach transcript out of B's reads", () => {
    const a = bindAccount(A);
    writeCache(a, "t1", { messages: [{ role: "user", text: "A secret" } as never], actions: [] });
    const b = bindAccount(B);
    expect(readCache(b, "t1").messages).toEqual([]);
  });

  it("an A health response that arrives after B binds is not cached for anyone and not returned", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const pending = fetchDaily(a, "2026-09-20", "2026-09-22", { fetchImpl: fetchImpl as never });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const b = bindAccount(B);
    answer(new Response(JSON.stringify({ days: [{ date: "2026-09-22", steps: 1234 }] }), { status: 200 }));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    expect(readAccountItem(b, "health_daily")).toBeNull();
    expect(localStorage.getItem(`smc:u:${A}:health_daily`)).toBeNull();
  });

  it("an A expenditure response that arrives after B binds is not cached for B", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const pending = fetchExpenditure(a, fetchImpl as never);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const b = bindAccount(B);
    answer(new Response(JSON.stringify({ value: 2100 }), { status: 200 }));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    expect(readAccountItem(b, "expenditure")).toBeNull();
  });

  it("a store save with a stale handle writes nothing", () => {
    const a = bindAccount(A);
    bindAccount(B);
    expect(() => saveStoreFor(a, defaultStore())).toThrow(AccountChanged);
    expect(localStorage.getItem(`smc:u:${B}:store`)).toBeNull();
    expect(localStorage.getItem(`smc:u:${A}:store`)).toBeNull();
  });

  it("serves B a fresh store, not A's cache, and keeps A's on the phone", () => {
    bindAccount(A);
    saveStore({ ...defaultStore(), days: { "2026-09-22": { eaten: { "meal-1": "x" } } } as never });
    bindAccount(B);
    expect(loadStore().days).toEqual({});
    expect(localStorage.getItem(`smc:u:${A}:store`)).not.toBeNull();
    unbindAccount();
    bindAccount(A);
    expect(Object.keys(loadStore().days)).toEqual(["2026-09-22"]);
  });

  it("does not persist a store with no bound account", () => {
    saveStore(defaultStore());
    expect(Object.keys(localStorage)).toEqual([]);
  });
});
