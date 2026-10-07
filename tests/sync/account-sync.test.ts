// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountChanged, bindAccount, markAccountReady, unbindAccount, type AccountHandle,
} from "@/lib/device/account";
import { mountAccountSync, startAccountSync } from "@/lib/sync/account-sync";
import { closeAllAccountDbs, getCursor, getLastError, setCursor } from "@/lib/sync/idb";
import { pullChanges, syncOnce } from "@/lib/sync/client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  globalThis.indexedDB = new IDBFactory();
});

describe("sync gating (Phase 9 §0.3)", () => {
  it("starts no pass before ready, one pass at ready, and none after the account is gone", () => {
    const run = vi.fn(async (_h: AccountHandle) => {});
    const unmount = mountAccountSync((h) => startAccountSync(h, { run }));
    const h = bindAccount(A);
    window.dispatchEvent(new Event("online"));
    expect(run).not.toHaveBeenCalled();
    markAccountReady(h);
    expect(run).toHaveBeenCalledTimes(1);
    unbindAccount();
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a pass in progress during a switch saves no cursor", async () => {
    const a = bindAccount(A);
    await setCursor(a, 3);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchFn = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ changes: [], next_cursor: 99, has_more: false }));
    }) as unknown as typeof fetch;
    const pass = pullChanges(a, undefined, { fetchFn });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    bindAccount(B);
    release();
    await expect(pass).rejects.toBeInstanceOf(AccountChanged);
    unbindAccount();
    expect(await getCursor(bindAccount(A))).toBe(3);
  });

  it("a pass that meets a switch records no error line for either account", async () => {
    const a = bindAccount(A);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchFn = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ changes: [], next_cursor: 1, has_more: false }));
    }) as unknown as typeof fetch;
    const pass = syncOnce(a, { fetchFn });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const b = bindAccount(B);
    release();
    await expect(pass).rejects.toBeInstanceOf(AccountChanged);
    expect(await getLastError(b)).toBeNull();
    unbindAccount();
    expect(await getLastError(bindAccount(A))).toBeNull();
  });

  it("the new account's pass starts after the switch, and only after B is ready", () => {
    const run = vi.fn(async (_h: AccountHandle) => {});
    const unmount = mountAccountSync((h) => startAccountSync(h, { run }));
    markAccountReady(bindAccount(A));
    const b = bindAccount(B);
    window.dispatchEvent(new Event("online"));
    expect(run.mock.calls.map(([h]) => h.userId)).toEqual([A]);
    markAccountReady(b);
    expect(run.mock.calls.map(([h]) => h.userId)).toEqual([A, B]);
    unmount();
  });
});
