import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getByGtin, type CachedRevision } from "@/lib/db/catalog-cache";
import {
  addPendingScan, clearPendingScan, pendingScansKey, readPendingScans,
  rememberScan, resolveOffline, startPendingScanReplay,
} from "@/lib/barcode/scan-cache";
import { resetTestAccount } from "@/tests/helpers/account";


const GTIN = "04006381333931";

function revision(id: number): CachedRevision {
  return {
    revision_id: id, catalog_food_id: id * 10, description: "Apple & blueberry pouch",
    brand: "Ella's Kitchen", source: "off", version_label: "off-2026-09-19",
    // Cached now: a fixed date ages past the retention window and is evicted on write.
    per_100g: { energy_kcal: 60, iron: null }, portions: [], cached_at: new Date().toISOString(),
  };
}

const store = new Map<string, string>();
beforeEach(async () => {
  await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
});

describe("the scan cache", () => {
  it("stores the revision under its GTIN and reads it back offline", async () => {
    await rememberScan(GTIN, revision(34));
    expect((await getByGtin(GTIN))?.revision_id).toBe(34);
    expect((await resolveOffline(GTIN))?.description).toBe("Apple & blueberry pouch");
    expect(await resolveOffline("00000096385074")).toBeNull();
  });

  it("treats a row past the retention window as stale at read time, with no further scan needed", async () => {
    const insertedAt = Date.parse("2026-07-01T00:00:00.000Z");
    const insertSpy = vi.spyOn(Date, "now").mockReturnValue(insertedAt);
    try {
      // cached_at matches "now" at insertion, so the reactive eviction inside rememberScan
      // has nothing to prune yet — the row only goes stale later, purely with the passage of time.
      await rememberScan(GTIN, { ...revision(34), cached_at: "2026-07-01T00:00:00.000Z" });
    } finally {
      insertSpy.mockRestore();
    }

    const readSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-19T12:00:00.000Z")); // 80 days later
    try {
      expect(await resolveOffline(GTIN)).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
  });

  it("keeps the revision_id key, so a searched and a scanned row are one row", async () => {
    await rememberScan(GTIN, revision(34));
    await rememberScan(GTIN, { ...revision(34), description: "Renamed" });
    expect((await getByGtin(GTIN))?.description).toBe("Renamed");
  });

  it("evicts stale scans whenever a new one is remembered, so the store never grows unbounded", async () => {
    const stale = "00000000000001";
    await rememberScan(stale, { ...revision(1), cached_at: "2026-06-01T00:00:00.000Z" });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-19T12:00:00.000Z"));
    try {
      await rememberScan(GTIN, revision(34));
    } finally {
      nowSpy.mockRestore();
    }

    expect(await getByGtin(stale)).toBeUndefined();
    expect((await getByGtin(GTIN))?.revision_id).toBe(34);
  });
});

describe("the pending scan queue", () => {
  it("queues one row per GTIN and clears it", () => {
    addPendingScan(GTIN, "2026-09-19T12:00:00.000Z");
    addPendingScan(GTIN, "2026-09-19T12:00:05.000Z");
    expect(readPendingScans()).toEqual([{ gtin14: GTIN, at: "2026-09-19T12:00:00.000Z" }]);
    expect(store.get(pendingScansKey()!)).toContain(GTIN);
    clearPendingScan(GTIN);
    expect(readPendingScans()).toEqual([]);
  });

  it("survives unparseable storage", () => {
    store.set(pendingScansKey()!, "{{{");
    expect(readPendingScans()).toEqual([]);
  });

  it("replays every queued scan on the online event and unsubscribes", async () => {
    const listeners: Record<string, EventListener[]> = {};
    vi.stubGlobal("window", {
      addEventListener: (t: string, fn: EventListener) => { (listeners[t] ??= []).push(fn); },
      removeEventListener: (t: string, fn: EventListener) => {
        listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
      },
    });
    addPendingScan(GTIN, "2026-09-19T12:00:00.000Z");
    const replay = vi.fn().mockResolvedValue(undefined);
    const stop = startPendingScanReplay(replay);
    listeners.online[0](new Event("online"));
    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(GTIN));
    expect(readPendingScans()).toEqual([]);
    stop();
    expect(listeners.online).toEqual([]);
  });
});
