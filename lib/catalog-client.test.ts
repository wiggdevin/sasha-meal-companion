import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putRevision } from "@/lib/db/catalog-cache";
import {
  cacheDetail,
  createSearchController,
  getFoodDetail,
  offPlanFlags,
  searchFoods,
  SEARCH_DEBOUNCE_MS,
  toCachedRevision,
  toRows,
} from "./catalog-client";
import { resetTestAccount } from "@/tests/helpers/account";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });


const HIT = {
  catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted", brand: null,
  source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
  score: 0.8123, prefStatus: "eats",
};

function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  ) as unknown as typeof fetch;
}

describe("searchFoods", () => {
  it("returns empty for a blank query and never calls the network", async () => {
    const fetchImpl = jsonFetch(200, {});
    await expect(searchFoods("   ", { fetchImpl })).resolves.toEqual({ kind: "empty" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses a 200 into hits, query class, auto-resolve and catalog version", async () => {
    const fetchImpl = jsonFetch(200, {
      hits: [HIT], queryClass: "generic",
      autoResolve: { revisionId: 910, score: 0.8123, margin: 0.21 }, catalogVersion: "2026-04",
    });
    const r = await searchFoods("chicken breast", { fetchImpl, limit: 10 });
    expect(r).toMatchObject({ kind: "online", queryClass: "generic", catalogVersion: "2026-04" });
    expect(r.kind === "online" && r.hits[0].description).toBe("Chicken breast, roasted");
    const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toBe("/api/foods/search?q=chicken+breast&limit=10");
  });

  it("puts brand and prep on the query string only when they are set", async () => {
    const fetchImpl = jsonFetch(200, { hits: [], queryClass: "branded", autoResolve: null, catalogVersion: "x" });
    await searchFoods("rx bar", { fetchImpl, brand: "RXBAR", prep: "raw" });
    const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toBe("/api/foods/search?q=rx+bar&limit=25&brand=RXBAR&prep=raw");
  });

  it("falls back to the bundled database on a 503 and says why", async () => {
    const r = await searchFoods("banana", { fetchImpl: jsonFetch(503, { error: "no_catalog" }) });
    expect(r.kind).toBe("offline");
    expect(r.kind === "offline" && r.reason).toBe("no_catalog");
    expect(r.kind === "offline" && r.hits.length).toBeGreaterThan(0);
  });

  it("returns real bean identities when a healthy catalog gives no hits", async () => {
    const r = await searchFoods("bean", { fetchImpl: jsonFetch(200, {
      hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v",
    }) });
    expect(r.kind).toBe("offline");
    expect(r.kind === "offline" && r.reason).toBe("no_match");
    expect(r.kind === "offline" && r.hits.some((hit) => /bean/i.test(hit.name))).toBe(true);
  });

  it("falls back to the bundled database when the fetch itself throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const r = await searchFoods("banana", { fetchImpl });
    expect(r).toMatchObject({ kind: "offline", reason: "network" });
  });

  it("lets an abort propagate instead of falling back", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn(async () => { throw new DOMException("Aborted", "AbortError"); }) as unknown as typeof fetch;
    await expect(searchFoods("banana", { fetchImpl, signal: ac.signal })).rejects.toThrow(/Aborted/);
  });
});

describe("offPlanFlags", () => {
  it.each([
    ["Chicken, breast, roasted", []],
    ["Cheese, cheddar", ["dairy"]],
    ["Almond milk, unsweetened", []],
    ["Bread, whole-wheat", ["gluten"]],
    ["Rice noodles, cooked", []],
    ["Applesauce, unsweetened", ["apple"]],
    ["Pizza, cheese", ["gluten", "dairy"]],
    ["Wheat Thins Original", ["gluten"]],
    ["Wheat germ", ["gluten"]],
    ["Rye crisp crackers", ["gluten"]],
    ["Semolina flour", ["gluten"]],
    ["Malt-O-Meal", ["gluten"]],
  ])("reads %s as %j", (name, expected) => {
    expect(offPlanFlags(name)).toEqual(expected);
  });
});

describe("toRows", () => {
  it("maps an online hit to a USDA tile and keeps the score order the server sent", () => {
    const rows = toRows({
      kind: "online", queryClass: "generic", autoResolve: null, catalogVersion: "2026-04",
      hits: [HIT as never, { ...HIT, catalogFoodId: 42, revisionId: 911, score: 0.4, prefStatus: null } as never],
    });
    expect(rows.map((r) => r.score)).toEqual([0.8123, 0.4]);
    expect(rows[0]).toMatchObject({ sourceTile: "USDA", prefStatus: "eats", offline: false, revisionId: 910 });
  });

  it("maps an off-sourced hit to the OFF tile", () => {
    const rows = toRows({
      kind: "online", queryClass: "branded", autoResolve: null, catalogVersion: "2026-04",
      hits: [{ ...HIT, source: "off" } as never],
    });
    expect(rows[0].sourceTile).toBe("OFF");
  });

  it("marks offline rows and tiles her own foods MINE", () => {
    const serving = { kcalPer100g: null, per100g: null,
      portions: [{ id: null, label: "100 g", grams: 100, kcal: null }], defaultPortion: null };
    const rows = toRows({
      kind: "offline", reason: "network",
      hits: [
        { id: "chicken-breast", name: "Chicken breast", source: "db", flags: [], score: 900, ...serving },
        { id: "my-shake", name: "Her shake", source: "mine", flags: [], score: 950, ...serving },
      ],
    });
    expect(rows.every((r) => r.offline)).toBe(true);
    expect(rows.map((r) => r.sourceTile)).toEqual(["USDA", "MINE"]);
    expect(rows[1].offlineFoodId).toBe("my-shake");
  });

  it("marks an off-plan description on the row", () => {
    const rows = toRows({
      kind: "online", queryClass: "generic", autoResolve: null, catalogVersion: "2026-04",
      hits: [{ ...HIT, description: "Pizza, cheese" } as never],
    });
    expect(rows[0].offPlan).toEqual(["gluten", "dairy"]);
  });

  it("carries the server's ingredient-based policy verdict through, even when the name itself doesn't say so", () => {
    const rows = toRows({
      kind: "online", queryClass: "generic", autoResolve: null, catalogVersion: "2026-04",
      hits: [{
        ...HIT, description: "Trail Mix", brand: "Nature Valley",
        policy: { verdict: "blocked", reason: "allergen:gluten" },
      } as never],
    });
    expect(rows[0].offPlan).toEqual(["gluten"]);
  });

  it("returns no rows for an empty result", () => {
    expect(toRows({ kind: "empty" })).toEqual([]);
  });

  it("carries a non-allergen blocked verdict through too — a banned category or her avoid list, not just allergens", () => {
    const category = toRows({
      kind: "online", queryClass: "generic", autoResolve: null, catalogVersion: "2026-04",
      hits: [{
        ...HIT, description: "Honey", brand: null,
        policy: { verdict: "blocked", reason: "category:simple_sugars" },
      } as never],
    });
    expect(category[0].offPlan).toEqual(["simple_sugars"]);

    const avoidList = toRows({
      kind: "online", queryClass: "generic", autoResolve: null, catalogVersion: "2026-04",
      hits: [{
        ...HIT, description: "Some food she reacted to", brand: null,
        policy: { verdict: "blocked", reason: "avoid_list" },
      } as never],
    });
    expect(avoidList[0].offPlan).toEqual(["avoid_list"]);
  });
});

describe("createSearchController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits the debounce before it calls the network", async () => {
    const fetchImpl = jsonFetch(200, { hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" });
    const c = createSearchController();
    const p = c.search("chi", { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await p;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a second keystroke inside the window replaces the first, which resolves null", async () => {
    const fetchImpl = jsonFetch(200, { hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" });
    const c = createSearchController();
    const first = c.search("chi", { fetchImpl });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS / 2);
    const second = c.search("chick", { fetchImpl });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await expect(first).resolves.toBeNull();
    expect((await second)?.kind).toBe("offline");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight request when the next keystroke arrives", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    const c = createSearchController();
    const first = c.search("chi", { fetchImpl });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const second = c.search("chick", { fetchImpl });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await Promise.all([first, second]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("cancel() drops a pending keystroke without a fetch", async () => {
    const fetchImpl = jsonFetch(200, { hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" });
    const c = createSearchController();
    const p = c.search("chi", { fetchImpl });
    c.cancel();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
    await expect(p).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("settles all three promises when a stale in-flight request lands after a second supersession", async () => {
    let resolveA!: (res: Response) => void;
    const aPromise = new Promise<Response>((resolve) => { resolveA = resolve; });
    const fetchA = vi.fn(async () => aPromise) as unknown as typeof fetch;
    const fetchBC = jsonFetch(200, { hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" });

    const controller = createSearchController();
    const a = controller.search("chi", { fetchImpl: fetchA });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); // A's timer fires; its fetch is now in flight

    const b = controller.search("chick", { fetchImpl: fetchBC });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS / 2); // still inside B's debounce window

    // A's fetch lands late, after B has registered as the pending promise.
    resolveA(new Response(JSON.stringify({ hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    const c = controller.search("chicken", { fetchImpl: fetchBC });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBeNull();
    expect((await c)?.kind).toBe("offline");
  });
});

describe("createSearchController with food discovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hit = (revisionId: number, description: string, policy?: unknown) =>
    ({ ...HIT, catalogFoodId: revisionId, revisionId, description, policy });
  const ONION_BLOCKED = hit(2, "Onions, raw", { verdict: "blocked", reason: "category:onion_garlic" });
  const BY_TERM: Record<string, unknown[]> = {
    "onion and garlic": [hit(1, "Seasoning, garlic and onion")],
    "Onion and garlic": [hit(1, "Seasoning, garlic and onion")],
    onion: [ONION_BLOCKED, hit(1, "Seasoning, garlic and onion")],
    garlic: [hit(3, "Garlic, raw")],
    leek: [], shallot: [],
  };

  /** Answers each term by its own `q`, and records every URL and signal the controller sent. */
  function termFetch(fail: string[] = [], hold = false) {
    const urls: string[] = [];
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      urls.push(input);
      if (init?.signal) signals.push(init.signal);
      const q = new URL(input, "https://app.test").searchParams.get("q") ?? "";
      if (fail.includes(q)) throw new TypeError("Failed to fetch");
      if (hold) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort",
          () => reject(new DOMException("Aborted", "AbortError"))));
      }
      return new Response(JSON.stringify({ hits: BY_TERM[q] ?? [], queryClass: "generic",
        autoResolve: null, catalogVersion: "v" }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls, signals };
  }

  it("issues every bounded term once and merges rows by stable key, raw phrase first", async () => {
    const { fetchImpl, urls } = termFetch();
    const pending = createSearchController().search("Onion and garlic", { fetchImpl, discover: true });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const result = await pending;
    // The raw phrase goes out as typed (brand detection reads its capitals); aliases follow.
    expect(urls.map((url) => new URL(url, "https://app.test").searchParams.get("q")))
      .toEqual(["Onion and garlic", "onion", "garlic", "leek", "shallot"]);
    expect(result?.kind).toBe("online");
    const rows = toRows(result!);
    expect(rows.map((row) => row.key)).toEqual(["catalog:1", "catalog:2", "catalog:3"]);
    // The server's own verdict still reaches the merged row.
    expect(rows[1].offPlan).toContain("onion_garlic");
  });

  it("sends an ordinary query once, exactly as before", async () => {
    const { fetchImpl, urls } = termFetch();
    const pending = createSearchController().search("garlic", { fetchImpl, discover: true });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await pending;
    expect(urls).toHaveLength(1);
  });

  it("keeps the raw phrase's answer when an alias request fails", async () => {
    const { fetchImpl } = termFetch(["garlic"]);
    const pending = createSearchController().search("onion and garlic", { fetchImpl, discover: true });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const result = await pending;
    expect(result?.kind).toBe("online");
    expect(toRows(result!).map((row) => row.key)).toEqual(["catalog:1", "catalog:2"]);
  });

  it("uses the aliases' catalog rows when the phrase itself has none, without auto-resolving", async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const q = new URL(input, "https://app.test").searchParams.get("q");
      const hits = q === "lentils" ? [hit(9, "Lentils, raw")] : [];
      return new Response(JSON.stringify({ hits, queryClass: "generic", catalogVersion: "v",
        autoResolve: hits.length ? { revisionId: 9, score: 0.9, margin: 0.5 } : null }), { status: 200 });
    }) as unknown as typeof fetch;
    // "beans" has bundled matches, so the phrase alone answers offline `no_match`.
    const pending = createSearchController().search("beans", { fetchImpl, discover: true });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const result = await pending;
    expect(result?.kind).toBe("online");
    expect(result?.kind === "online" && result.autoResolve).toBeNull();
    expect(toRows(result!).map((row) => row.key)).toEqual(["catalog:9"]);
  });

  it("aborts every term of a superseded keystroke", async () => {
    const held = termFetch([], true);
    const { fetchImpl } = termFetch();
    const c = createSearchController();
    const first = c.search("onion and garlic", { fetchImpl: held.fetchImpl, discover: true });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const firstSignals = [...held.signals];
    expect(firstSignals.some((signal) => signal.aborted)).toBe(false);
    const second = c.search("onion", { fetchImpl, discover: true });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await expect(first).resolves.toBeNull();
    expect((await second)?.kind).toBe("online");
    expect(firstSignals).toHaveLength(5);
    expect(firstSignals.every((signal) => signal.aborted)).toBe(true);
  });
});

const DETAIL = {
  catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted", brand: null,
  source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
  score: 0, prefStatus: null, category: "Poultry Products", catalogVersion: "2026-04",
  attribution: "USDA SR Legacy 2026-04",
  // The full nutrient-code map and full catalog_portions rows — FoodDetail's own, pre-existing
  // fields (several components read these by this exact name/shape), distinct from the UI lane's
  // simplified serving-data fields below so the two never collide.
  per100g: {
    energy_kcal: { amount: 165, unit: "kcal" }, protein: { amount: 31, unit: "g" },
    carbohydrate: { amount: 0, unit: "g" }, fat_total: { amount: 3.6, unit: "g" },
    fiber_total: { amount: null, unit: "g" },
  },
  portions: [{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }],
  // UI lane contract (lib/foods/portions.ts).
  kcalPer100g: 165,
  simplePer100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
  defaultPortion: { id: "3", label: "3 oz", grams: 85, kcal: 140 },
  servingPortions: [
    { id: "3", label: "3 oz", grams: 85, kcal: 140 },
    { id: null, label: "100 g", grams: 100, kcal: 165 },
  ],
  ingredients: [],
};

describe("getFoodDetail", () => {
  beforeEach(async () => { await resetTestAccount(); globalThis.indexedDB = new IDBFactory(); });

  it("returns the detail on a 200", async () => {
    const fetchImpl = jsonFetch(200, DETAIL);
    const r = await getFoodDetail(41, { fetchImpl });
    expect(r).toMatchObject({ kind: "ok" });
    const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toBe("/api/foods/41");
  });

  it("returns not_found on a 404", async () => {
    await expect(getFoodDetail(41, { fetchImpl: jsonFetch(404, { error: "not_found" }) }))
      .resolves.toEqual({ kind: "not_found" });
  });

  it("serves the cached revision when the network is gone and we have seen the food", async () => {
    await putRevision(toCachedRevision(DETAIL as never, Date.parse("2026-09-11T10:00:00.000Z")));
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const r = await getFoodDetail(41, { revisionId: 910, fetchImpl });
    expect(r.kind).toBe("cached");
    expect(r.kind === "cached" && r.revision.per_100g.protein).toBe(31);
  });

  it("blocks the food when the network is gone and nothing is cached", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(getFoodDetail(41, { revisionId: 910, fetchImpl })).resolves.toEqual({ kind: "blocked" });
  });
});

describe("toCachedRevision", () => {
  it("keeps a measured zero and a null apart, and copies the portions", () => {
    const row = toCachedRevision(DETAIL as never, Date.parse("2026-09-11T10:00:00.000Z"));
    expect(row.per_100g.carbohydrate).toBe(0);
    expect(row.per_100g.fiber_total).toBeNull();
    expect(row.version_label).toBe("2026-04");
    expect(row.portions).toEqual([{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }]);
    expect(row.cached_at).toBe("2026-09-11T10:00:00.000Z");
  });

  it("also mirrors the UI lane's serving-data fields, under names that cannot collide with the " +
    "legacy portions/per_100g fields above", () => {
    const row = toCachedRevision(DETAIL as never, Date.parse("2026-09-11T10:00:00.000Z"));
    expect(row.kcalPer100g).toBe(165);
    expect(row.per100g).toEqual({ kcal: 165, protein: 31, carbs: 0, fat: 3.6 });
    expect(row.defaultPortion).toEqual({ id: "3", label: "3 oz", grams: 85, kcal: 140 });
    expect(row.servingPortions).toEqual([
      { id: "3", label: "3 oz", grams: 85, kcal: 140 },
      { id: null, label: "100 g", grams: 100, kcal: 165 },
    ]);
  });
});

describe("cacheDetail", () => {
  beforeEach(async () => { await resetTestAccount(); globalThis.indexedDB = new IDBFactory(); });
  it("writes the revision through to IndexedDB", async () => {
    await cacheDetail(DETAIL as never, Date.parse("2026-09-11T10:00:00.000Z"));
    const { getRevision } = await import("@/lib/db/catalog-cache");
    await expect(getRevision(910)).resolves.toMatchObject({ description: "Chicken breast, roasted" });
  });
});
