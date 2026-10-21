// @vitest-environment jsdom
/**
 * Show/Hide for companions (UI makeover W3, lib/today/companion-visibility.ts): the phone changes at
 * once; the write applies only its own key to the mirrored settings row (a newer companion this
 * phone does not know kept, a full list refused) and tells the sync loop; a failure puts back only
 * its own key; and a write never crosses into another account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  COMPANION_VISIBILITY_EVENT, CompanionsHiddenFull, hiddenCompanions, setCompanionShown, useCompanionShown,
  withCompanionShown, writeCompanionShown,
} from "@/lib/today/companion-visibility";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { OUTBOX_QUEUED_EVENT } from "@/lib/sync/outbox";
import type { MascotKey } from "@/lib/profile/mascot";

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
type Mutate = (row: Record<string, unknown>) => { row: Record<string, unknown>; op: { payload: Record<string, unknown>; base_rev: number | null } };
const mirror = vi.hoisted(() => ({ row: {} as Record<string, unknown>, ops: [] as { payload: Record<string, unknown>; base_rev: number | null }[] }));
vi.mock("@/lib/sync/outbox", async (original) => ({
  ...(await original<typeof import("@/lib/sync/outbox")>()),
  mutateUserSettings: async (_h: unknown, mutate: Mutate) => {
    const { row, op } = mutate(mirror.row);
    mirror.row = row; mirror.ops.push(op);
  },
}));
const write = vi.fn<(h: Handle, key: MascotKey, shown: boolean) => Promise<void>>();

beforeEach(() => {
  store.settings = {}; account.current = { userId: "a", epoch: 1 };
  mirror.row = { rev: 4 }; mirror.ops = [];
  write.mockReset(); write.mockResolvedValue(undefined);
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

describe("writeCompanionShown", () => {
  it("changes only its key on the mirrored row, keeps unknown keys, and tells the sync loop", async () => {
    mirror.row = { rev: 4, companions_hidden: ["dragon", "peapod"], mascot: "sprout" };
    const told = vi.fn();
    window.addEventListener(OUTBOX_QUEUED_EVENT, told);
    await writeCompanionShown({ userId: "a", epoch: 1 }, "sprout", false);
    await writeCompanionShown({ userId: "a", epoch: 1 }, "peapod", true);
    window.removeEventListener(OUTBOX_QUEUED_EVENT, told);
    expect(mirror.row.companions_hidden).toEqual(["dragon", "sprout"]);
    expect(mirror.ops[0].payload).toEqual({ companions_hidden: ["dragon", "peapod", "sprout"], mascot: "sprout" });
    expect(mirror.ops[0].base_rev).toBe(4);
    expect(told).toHaveBeenCalledTimes(2);
  });

  it("refuses a hide past the cap of 8 instead of dropping it", async () => {
    mirror.row = { rev: 4, companions_hidden: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"] };
    await expect(writeCompanionShown({ userId: "a", epoch: 1 }, "sprout", false)).rejects.toBeInstanceOf(CompanionsHiddenFull);
    expect(mirror.ops).toHaveLength(0);
  });
});

describe("setCompanionShown", () => {
  it("hides at once and writes only its key for the account at the tap", async () => {
    const told = vi.fn();
    window.addEventListener(COMPANION_VISIBILITY_EVENT, told);
    await setCompanionShown("sprout", false, { write });
    window.removeEventListener(COMPANION_VISIBILITY_EVENT, told);
    expect(store.settings.companionsHidden).toEqual(["sprout"]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]).toEqual([{ userId: "a", epoch: 1 }, "sprout", false]);
    expect(told).toHaveBeenCalled();
  });

  it("keeps a newer companion this phone does not know", async () => {
    store.settings = { companionsHidden: ["dragon"] };
    await setCompanionShown("sprout", false, { write });
    expect(store.settings.companionsHidden).toEqual(["dragon", "sprout"]);
  });

  it("a pull that lands while the write waits keeps the tap on the phone", async () => {
    let release!: () => void;
    write.mockImplementationOnce(() => new Promise<void>((go) => { release = go; }));
    const first = setCompanionShown("peapod", false, { write });
    const second = setCompanionShown("sprout", false, { write });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    store.settings = { companionsHidden: [] };
    release();
    await first; await second;
    expect(write.mock.calls.map((c) => [c[1], c[2]])).toEqual([["peapod", false], ["sprout", false]]);
    expect(store.settings.companionsHidden).toEqual(["peapod", "sprout"]);
  });

  it("a failed write puts back only its own key, and a later change to another companion stands", async () => {
    store.settings = { companionsHidden: ["peapod"] };
    let fail!: (error: Error) => void;
    write.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    const first = setCompanionShown("sprout", false, { write });
    const second = setCompanionShown("peapod", true, { write });
    expect(store.settings.companionsHidden).toEqual(["sprout"]);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    fail(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    await second;
    expect(store.settings.companionsHidden).toEqual([]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("refuses with no account, and never touches another account after a switch", async () => {
    await expect(setCompanionShown("sprout", false, { h: null, write })).rejects.toThrow("No account");
    let release!: () => void;
    write.mockImplementationOnce(() => new Promise<void>((go) => { release = go; }));
    const blocker = setCompanionShown("blueberry", false, { write });
    const waiting = setCompanionShown("sprout", false, { write }).catch((error: Error) => error);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    account.current = { userId: "b", epoch: 2 };
    release();
    await blocker;
    expect(((await waiting) as Error).message).toBe("account changed");
    expect(write).toHaveBeenCalledTimes(1);
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
