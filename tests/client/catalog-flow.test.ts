import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogSearchEnabled, getFoodDetail, searchFoods, toRows } from "@/lib/catalog-client";
import { getRevision } from "@/lib/db/catalog-cache";
import { buildCommitRequest, liveStrip } from "@/lib/log-client";
import { commitLogEntry, pendingEntryIds } from "@/lib/log-commit-client";
import { allOps } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const DETAIL = {
  catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted", brand: null,
  source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
  score: 0, prefStatus: "eats", category: "Poultry Products", catalogVersion: "2026-04",
  attribution: "USDA SR Legacy 2026-04",
  per100g: {
    energy_kcal: { amount: 165, unit: "kcal" }, protein: { amount: 31, unit: "g" },
    carbohydrate: { amount: 0, unit: "g" }, fat_total: { amount: 3.6, unit: "g" },
    fiber_total: { amount: null, unit: "g" },
  },
  portions: [{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }],
  ingredients: [],
};

function router(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[key].body), {
      status: routes[key].status, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(async () => { h = await resetTestAccount(); globalThis.indexedDB = new IDBFactory(); });
afterEach(() => vi.unstubAllEnvs());

describe("the flag", () => {
  it("is off when NEXT_PUBLIC_CATALOG_SEARCH is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_CATALOG_SEARCH", "");
    expect(catalogSearchEnabled()).toBe(false);
  });
  it("is on only for the exact value 1", () => {
    vi.stubEnv("NEXT_PUBLIC_CATALOG_SEARCH", "1");
    expect(catalogSearchEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_CATALOG_SEARCH", "true");
    expect(catalogSearchEnabled()).toBe(false);
  });
});

describe("search → detail → cache → commit", () => {
  it("carries one food all the way to a committed entry", async () => {
    const fetchImpl = router({
      "/api/foods/search": { status: 200, body: {
        hits: [{ catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted",
                 brand: null, source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [],
                 prepState: "roasted", score: 0.81, prefStatus: "eats" }],
        queryClass: "generic", autoResolve: null, catalogVersion: "2026-04" } },
      "/api/foods/41": { status: 200, body: DETAIL },
      "/api/log/commit": { status: 200, body: {
        status: "ok", entry_id: "e1", rev: 1, items: [],
        totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } } },
    });

    const rows = toRows(await searchFoods("chicken breast", { fetchImpl }));
    expect(rows[0]).toMatchObject({ sourceTile: "USDA", prefStatus: "eats", catalogFoodId: 41 });

    const detail = await getFoodDetail(41, { fetchImpl });
    expect(detail.kind).toBe("ok");
    const cached = await getRevision(910);
    expect(cached?.per_100g.protein).toBe(31);

    expect(liveStrip(cached!, 140)).toMatchObject({ kcal: 231, protein: 43.4 });

    const req = buildCommitRequest({
      entryId: "e1", eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "UTC", slot: "meal-2",
      items: [{ id: "i1", foodRefId: "f1", revision: cached!, grams: 140, qty: 140, unit: "g" }],
    });
    await expect(commitLogEntry(req, { fetchImpl })).resolves.toMatchObject({ status: "ok" });
    // Nothing is left queued: the server took it. The entry stays MARKED, though, because this
    // reply names no items and there is no session here to read the stored row back with — and
    // the mark is a claim about the mirror, not about the post (Grok pass 4, HIGH 2).
    await expect(allOps(h)).resolves.toHaveLength(0);
    await expect(pendingEntryIds()).resolves.toEqual(new Set(["e1"]));
  });

  it("with no catalog version the search goes offline and the detail blocks an unseen food", async () => {
    const fetchImpl = router({
      "/api/foods/search": { status: 503, body: { error: "no_catalog" } },
      "/api/foods/41": { status: 503, body: { error: "no_catalog" } },
    });
    const result = await searchFoods("banana", { fetchImpl });
    expect(result).toMatchObject({ kind: "offline", reason: "no_catalog" });
    expect(toRows(result).every((r) => r.offline)).toBe(true);
    await expect(getFoodDetail(41, { revisionId: 910, fetchImpl })).resolves.toEqual({ kind: "blocked" });
  });
});
