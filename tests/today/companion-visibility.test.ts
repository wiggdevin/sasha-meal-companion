// @vitest-environment jsdom
/**
 * Show/Hide for companions (UI makeover W3, lib/today/companion-visibility.ts): the phone changes at
 * once, the write is the one `companionsHidden` field on the shared queue, a failure puts back only
 * its own key, and a write never crosses into another account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { COMPANION_VISIBILITY_EVENT, hiddenCompanions, setCompanionShown, useCompanionShown, withCompanionShown }
  from "@/lib/today/companion-visibility";
import { SYNCED_EVENT } from "@/lib/sync/client";

type Handle = { userId: string; epoch: number };
const account = vi.hoisted(() => ({ current: { userId: "a", epoch: 1 } as Handle | null }));
const same = (h: Handle) => account.current?.userId === h.userId && account.current.epoch === h.epoch;
vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  currentAccountOrNull: () => account.current,
  assertCurrent: (h: Handle) => { if (!same(h)) throw new Error("account changed"); },
}));
const store = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock("@/lib/store", () => ({
  loadStore: () => ({ settings: { ...store.settings } }),
  saveStoreFor: (h: Handle, next: { settings: Record<string, unknown> }) => {
    if (!same(h)) throw new Error("account changed");
    store.settings = { ...next.settings };
  },
}));
const sync = vi.fn<(settings: { companionsHidden?: string[] }, h: Handle | undefined, fields: readonly string[]) => Promise<void>>();

beforeEach(() => {
  store.settings = {}; account.current = { userId: "a", epoch: 1 };
  sync.mockReset(); sync.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the hidden list", () => {
  it("keeps known keys once, in order, and reads a missing list as nothing hidden", () => {
    expect(hiddenCompanions({ companionsHidden: ["peapod", "dragon", "peapod", "sprout"] })).toEqual(["peapod", "sprout"]);
    expect(hiddenCompanions({})).toEqual([]);
    expect(withCompanionShown(["sprout", "peapod"], "sprout", true)).toEqual(["peapod"]);
    expect(withCompanionShown(["peapod"], "sprout", false)).toEqual(["peapod", "sprout"]);
    expect(withCompanionShown(["sprout"], "sprout", false)).toEqual(["sprout"]);
  });
});

describe("setCompanionShown", () => {
  it("hides at once and sends only companionsHidden for the account at the tap", async () => {
    const told = vi.fn();
    window.addEventListener(COMPANION_VISIBILITY_EVENT, told);
    await setCompanionShown("sprout", false, { sync });
    window.removeEventListener(COMPANION_VISIBILITY_EVENT, told);
    expect(store.settings.companionsHidden).toEqual(["sprout"]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0].companionsHidden).toEqual(["sprout"]);
    expect(sync.mock.calls[0][1]).toEqual({ userId: "a", epoch: 1 });
    expect(sync.mock.calls[0][2]).toEqual(["companionsHidden"]);
    expect(told).toHaveBeenCalled();
  });

  it("a failed write puts back only its own key, and a later change to another companion stands", async () => {
    store.settings = { companionsHidden: ["peapod"] };
    let fail!: (error: Error) => void;
    sync.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    const first = setCompanionShown("sprout", false, { sync });
    const second = setCompanionShown("peapod", true, { sync });
    expect(store.settings.companionsHidden).toEqual(["sprout"]);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    fail(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    await second;
    expect(store.settings.companionsHidden).toEqual([]);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("refuses with no account, and never touches another account after a switch", async () => {
    await expect(setCompanionShown("sprout", false, { h: null, sync })).rejects.toThrow("No account");
    let release!: () => void;
    sync.mockImplementationOnce(() => new Promise<void>((go) => { release = go; }));
    const blocker = setCompanionShown("blueberry", false, { sync });
    const waiting = setCompanionShown("sprout", false, { sync }).catch((error: Error) => error);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    account.current = { userId: "b", epoch: 2 };
    release();
    await blocker;
    expect(((await waiting) as Error).message).toBe("account changed");
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe("useCompanionShown", () => {
  it("is shown by default and follows a local change and a pull", () => {
    const { result } = renderHook(() => useCompanionShown("sprout"));
    expect(result.current).toBe(true);
    store.settings = { companionsHidden: ["sprout"] };
    act(() => { window.dispatchEvent(new Event(COMPANION_VISIBILITY_EVENT)); });
    expect(result.current).toBe(false);
    store.settings = { companionsHidden: [] };
    act(() => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    expect(result.current).toBe(true);
  });
});
