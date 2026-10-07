import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { evictOlderThan, getByGtin, getRevision, putRevision, type CachedRevision } from "./catalog-cache";
import { resetTestAccount } from "@/tests/helpers/account";


function row(id: number, cachedAt: string): CachedRevision {
  return {
    revision_id: id, catalog_food_id: id * 10, description: "Chicken breast, roasted",
    brand: null, source: "fdc_sr_legacy", version_label: "2026-04",
    per_100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: null },
    portions: [{ id: 1, description: "3 oz", gramWeight: 85, isDefault: true }],
    cached_at: cachedAt,
  };
}

beforeEach(async () => {
  await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
});

describe("the catalog revision cache", () => {
  it("round-trips a revision keyed by revision_id", async () => {
    await putRevision(row(7, "2026-09-11T10:00:00.000Z"));
    const back = await getRevision(7);
    expect(back?.description).toBe("Chicken breast, roasted");
    expect(back?.per_100g.fiber_total).toBeNull();
    expect(back?.portions[0].gramWeight).toBe(85);
  });

  it("returns undefined for a revision it has never seen", async () => {
    await expect(getRevision(404)).resolves.toBeUndefined();
  });

  it("overwrites a revision it already holds", async () => {
    await putRevision(row(7, "2026-09-11T10:00:00.000Z"));
    await putRevision({ ...row(7, "2026-09-12T10:00:00.000Z"), description: "Chicken breast, grilled" });
    expect(await getRevision(7)).toMatchObject({ description: "Chicken breast, grilled" });
  });

  it("returns the newest revision when a GTIN has more than one cached row", async () => {
    const gtin = "0123456789012";
    // Inserted in ascending revision_id (IndexedDB key) order, oldest first — as a re-fetched
    // barcode would land after the original scan.
    await putRevision({ ...row(500, "2026-07-01T00:00:00.000Z"), gtin14: gtin });
    await putRevision({ ...row(640, "2026-09-10T00:00:00.000Z"), gtin14: gtin, description: "Corrected" });
    const back = await getByGtin(gtin);
    expect(back?.revision_id).toBe(640);
    expect(back?.description).toBe("Corrected");
  });

  it("evicts only rows older than the cut-off and reports how many went", async () => {
    const now = Date.parse("2026-09-20T00:00:00.000Z");
    await putRevision({ ...row(1, "2026-08-01T00:00:00.000Z"), gtin14: "00000000000001" });  // 50 days
    await putRevision({ ...row(2, "2026-09-18T00:00:00.000Z"), gtin14: "00000000000002" });  // 2 days
    await expect(evictOlderThan(30, now)).resolves.toBe(1);
    await expect(getRevision(1)).resolves.toBeUndefined();
    await expect(getRevision(2)).resolves.toBeDefined();
  });

  it("never evicts a row cached from search, only barcode-scanned rows", async () => {
    // A revision cached purely from food search carries no gtin14 (lib/catalog-client.ts
    // cacheDetail). evictOlderThan is only ever called from the barcode scan path
    // (lib/barcode/scan-cache.ts rememberScan) and must not sweep search's cache.
    const now = Date.parse("2026-09-20T00:00:00.000Z");
    await putRevision(row(3, "2026-08-01T00:00:00.000Z"));  // 50 days old, no gtin14
    await expect(evictOlderThan(30, now)).resolves.toBe(0);
    await expect(getRevision(3)).resolves.toBeDefined();
  });
});
