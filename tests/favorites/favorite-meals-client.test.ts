import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, type AccountHandle } from "@/lib/device/account";
import {
  favoriteMealFor, removeFavoriteMeal, saveFavoriteMeal, undoSaveFavoriteMeal,
  type FavoriteMealRefs, type FavoriteMealSource, type FavorVerdict,
} from "@/lib/favorite-meals-client";
import type { Food } from "@/lib/foods";
import {
  FOOD_PREF_REFS_KEY, __resetEatsFacetWarmTimers, __resetFoodMembershipState, readFoodMembership,
  setFoodMembership,
} from "@/lib/foods/prefs-client";
import { __resetStoreCache, getFoods, upsertFood } from "@/lib/store";
import { uuidV5 } from "@/lib/foods/uuid5";
import { allOps, allRows, deleteRow, getRow, putRow } from "@/lib/sync/idb";
import type { FoodComponent } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import { toggleFavorite } from "@/lib/favorites-client";
import { StampedEligibleSet } from "@/lib/foods/eligible-client";
import { foodRulesEpoch, noteFoodRulesChanged } from "@/lib/foods/rules-epoch";
import { foodRulesKey } from "@/lib/foods/rule-marks";
import { getMeta, outboxRow, putMeta } from "@/lib/sync/idb";
import { loadStore } from "@/lib/store";
import { resumeFavoriteMealMarks } from "@/lib/favorite-meals-client";

// The outbox row builder, wrapped so a test can make the op write itself fail mid-transaction.
vi.mock("@/lib/sync/idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/idb")>();
  return { ...actual, outboxRow: vi.fn(actual.outboxRow) };
});

let h: AccountHandle;

const RICE_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EGG_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CAT_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const UNI_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const RICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EGG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

function food(id: string, name: string, role: Food["role"]): Food {
  return { id, name, role, unit: "g", perUnit: { protein: 0.1, carbs: 0.2, fat: 0.01 },
    status: "eats", updatedAt: "2026-10-01T00:00:00.000Z" };
}

const FOODS: Record<string, Food> = {
  [RICE_ID]: food(RICE_ID, "Rice", "carb"),
  [EGG_ID]: food(EGG_ID, "Egg", "protein"),
  "universe:banana-raw": { ...food("universe:banana-raw", "Banana", "carb") },
};

function component(name: string, qty: number, foodKey?: string): FoodComponent {
  return { name, qty, unit: "g", role: "carb", macros: { protein: 1, carbs: 2, fat: 0, kcal: 12 },
    ...(foodKey ? { foodKey } : {}) };
}

const PLATE = [component("Rice", 150, `food:${RICE_ID}`), component("Egg", 100, `food:${EGG_ID}`)];
const SOURCE: FavoriteMealSource = { date: "2026-10-08", slotId: "meal-1", mealId: "plate:abc" };

function refs(overrides: Partial<FavoriteMealRefs> = {}): FavoriteMealRefs {
  const byFood: Record<string, string> = { [RICE_ID]: RICE_REF, [EGG_ID]: EGG_REF };
  return {
    account: vi.fn(async (f: Food) => byFood[f.id] ?? `aaaaaaaa-aaaa-4aaa-8aaa-${f.id.slice(-12)}`),
    catalog: vi.fn(async () => CAT_REF),
    bundled: vi.fn(async () => UNI_REF),
    ...overrides,
  };
}

function save(over: Partial<Parameters<typeof saveFavoriteMeal>[1]> = {}, components = PLATE,
  source = SOURCE) {
  return saveFavoriteMeal({ name: "Rice and egg", components, source },
    { foods: FOODS, online: true, refs: refs(), ...over });
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
}

let synced = 0;

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:9");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  synced = 0;
  vi.stubGlobal("dispatchEvent", vi.fn((event: Event) => {
    if (event.type === "meal-companion:synced") synced += 1;
    return true;
  }));
  __resetStoreCache();
  __resetFoodMembershipState();
  seedStore([FOODS[RICE_ID], FOODS[EGG_ID]]);
});
afterEach(() => { __resetEatsFacetWarmTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** The account's Foods rows, with their refs cached so no mark asks the network. */
function seedStore(rows: Food[]): void {
  for (const row of rows) upsertFood(row);
  localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify({ [h.userId]: Object.fromEntries(rows.map((row, i) =>
    [row.id, { userRefId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(i).padStart(2, "0")}`,
      syncedAt: "2026-10-01T00:00:00.000Z", status: row.status === "neutral" ? null : row.status, note: null }])) }));
}

function membershipOps() {
  return allOps(h).then((ops) => ops.filter((op) => op.entity === "food_membership"));
}

describe("saveFavoriteMeal", () => {
  it("writes the row, its items and ONE create op locally, and no food-level mark", async () => {
    const outcome = await save();
    expect(outcome).toMatchObject({ ok: true, newlyFavored: [], skipped: [] });
    if (!outcome.ok) return;
    const rows = await allRows(h, "favorites_meals");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: outcome.id, name: "Rice and egg", sort: 1, deleted_at: null,
      items: [{ meal_id: outcome.id, seq: 1, food_ref_id: RICE_REF, grams: 150 },
        { meal_id: outcome.id, seq: 2, food_ref_id: EGG_REF, grams: 100 }] });
    const ops = await allOps(h);
    expect(ops.map((op) => [op.entity, op.kind])).toEqual([["favorites_meals", "create"]]);
    expect(ops[0]).toMatchObject({ entity_id: outcome.id, base_rev: null, user_id: h.userId,
      op_id: await uuidV5("5d7c2f1e-8a4b-4c3d-9e6f-1b2a3c4d5e6f",
        `favorite-meal:create:${h.userId}:${outcome.id}`) });
    expect(ops[0].payload).toEqual({ id: outcome.id, name: "Rice and egg", sort: 1,
      items: [{ seq: 1, food_ref_id: RICE_REF, grams: 150 }, { seq: 2, food_ref_id: EGG_REF, grams: 100 }] });
    expect(synced).toBe(1);
    expect(await favoriteMealFor(SOURCE, h)).toBe(outcome.id);
  });

  it("is idempotent per plate: a retry or a double tap answers the same id and queues nothing more", async () => {
    const [a, b] = await Promise.all([save(), save()]);
    const c = await save();
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(await allOps(h)).toHaveLength(1);
    expect(await allRows(h, "favorites_meals")).toHaveLength(1);
  });

  it("gives another plate (another meal on the slot) its own saved meal and the next sort", async () => {
    const a = await save();
    const b = await save({}, PLATE, { ...SOURCE, mealId: "plate:def" });
    expect(a.ok && b.ok && a.id !== b.id).toBe(true);
    const rows = await allRows(h, "favorites_meals");
    expect(rows.map((r) => r.sort).sort()).toEqual([1, 2]);
  });

  it("answers offline and writes nothing when a ref cannot be had offline", async () => {
    const outcome = await save({ online: false,
      refs: refs({ account: vi.fn(async () => null) }) });
    expect(outcome).toMatchObject({ ok: false, reason: "offline" });
    expect(await allOps(h)).toEqual([]);
    expect(await allRows(h, "favorites_meals")).toEqual([]);
    expect(await favoriteMealFor(SOURCE, h)).toBeNull();
    expect(synced).toBe(0);
  });

  it("saves offline when every ref is already known, telling the resolver it is offline", async () => {
    const r = refs();
    const outcome = await save({ online: false, refs: r });
    expect(outcome.ok).toBe(true);
    expect(r.account).toHaveBeenCalledWith(expect.objectContaining({ id: RICE_ID }), h, false);
    expect(await allOps(h)).toHaveLength(1);
  });

  it("answers retry online when a ref is refused, and a later retry saves once", async () => {
    const failing = await save({ refs: refs({ account: vi.fn(async () => { throw new Error("rpc"); }) }) });
    expect(failing).toMatchObject({ ok: false, reason: "retry" });
    expect(await allOps(h)).toEqual([]);
    const ok = await save();
    expect(ok.ok).toBe(true);
    expect(await allOps(h)).toHaveLength(1);
  });

  it("uses the catalog registry and the bundled adoption for catalog-only and universe foods", async () => {
    const r = refs();
    const outcome = await save({ refs: r }, [component("Oats", 40, "catalog:777"),
      component("Banana", 118, "food:banana-raw")]);
    expect(outcome.ok).toBe(true);
    expect(r.catalog).toHaveBeenCalledWith(777, h, true);
    expect(r.bundled).toHaveBeenCalledWith("banana-raw", h, true);
    const [op] = await allOps(h);
    expect((op.payload.items as unknown[])).toEqual([{ seq: 1, food_ref_id: CAT_REF, grams: 40 },
      { seq: 2, food_ref_id: UNI_REF, grams: 118 }]);
  });

  it("matches a keyless component to exactly one food of its name", async () => {
    const outcome = await save({}, [component("rice", 90)]);
    expect(outcome.ok).toBe(true);
    const [op] = await allOps(h);
    expect(op.payload.items).toEqual([{ seq: 1, food_ref_id: RICE_REF, grams: 90 }]);
  });

  it("refuses a plate with a food it cannot identify or weigh, writing nothing", async () => {
    expect(await save({}, [component("Mystery stew", 100)])).toMatchObject({ ok: false, reason: "refused" });
    expect(await save({}, [{ ...component("Rice", 1, `food:${RICE_ID}`), unit: "cup" }]))
      .toMatchObject({ ok: false, reason: "refused" });
    expect(await save({}, [component("Rice", 0, `food:${RICE_ID}`)])).toMatchObject({ ok: false, reason: "refused" });
    expect(await saveFavoriteMeal({ name: "  ", components: PLATE, source: SOURCE },
      { foods: FOODS, online: true, refs: refs() })).toMatchObject({ ok: false, reason: "refused" });
    expect(await allOps(h)).toEqual([]);
  });

  it("refuses when signed out", async () => {
    expect(await save({ account: null })).toMatchObject({ ok: false, reason: "refused" });
  });

  it("never writes as an account that is no longer bound", async () => {
    const before = h;
    bindAccount("22222222-2222-4222-8222-222222222222");
    await expect(save({ account: before })).rejects.toThrow(/account changed/i);
  });
});

describe("removeFavoriteMeal", () => {
  it("tombstones exactly that id with a delete op, and clears the plate's heart", async () => {
    const a = await save();
    const b = await save({}, PLATE, { ...SOURCE, mealId: "plate:def" });
    if (!a.ok || !b.ok) throw new Error("setup");
    synced = 0;
    expect(await removeFavoriteMeal(a.id, { account: h })).toEqual({ ok: true, id: a.id });
    const ops = await allOps(h);
    expect(ops.at(-1)).toMatchObject({ entity: "favorites_meals", entity_id: a.id, kind: "delete",
      base_rev: 1 });
    expect((await getRow(h, "favorites_meals", a.id))?.deleted_at).toBeTruthy();
    // The other saved meal, with the same name, is untouched.
    expect((await getRow(h, "favorites_meals", b.id))?.deleted_at).toBeNull();
    expect(await favoriteMealFor(SOURCE, h)).toBeNull();
    expect(await favoriteMealFor({ ...SOURCE, mealId: "plate:def" }, h)).toBe(b.id);
    expect(synced).toBe(1);
  });

  it("is idempotent: removing a removed or unknown meal answers ok and queues nothing", async () => {
    const a = await save();
    if (!a.ok) throw new Error("setup");
    await removeFavoriteMeal(a.id, { account: h });
    const count = (await allOps(h)).length;
    expect(await removeFavoriteMeal(a.id, { account: h })).toEqual({ ok: true, id: a.id });
    expect(await removeFavoriteMeal("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { account: h })).toMatchObject({ ok: true });
    expect(await allOps(h)).toHaveLength(count);
  });

  it("a heart after removal saves a new meal, never restoring the old one", async () => {
    const a = await save();
    if (!a.ok) throw new Error("setup");
    await removeFavoriteMeal(a.id, { account: h });
    const b = await save();
    expect(b.ok && b.id !== a.id).toBe(true);
    expect((await getRow(h, "favorites_meals", a.id))?.deleted_at).toBeTruthy();
  });
});

describe("favoriteMealFor", () => {
  it("is null for a plate never saved", async () => {
    expect(await favoriteMealFor(SOURCE, h)).toBeNull();
  });

  it("is null once another device tombstoned or deleted the row (a pull)", async () => {
    const a = await save();
    if (!a.ok) throw new Error("setup");
    const row = await getRow(h, "favorites_meals", a.id);
    await putRow(h, "favorites_meals", a.id, { ...row, rev: 2, deleted_at: "2026-10-08T10:00:00.000Z" });
    expect(await favoriteMealFor(SOURCE, h)).toBeNull();
    await deleteRow(h, "favorites_meals", a.id);
    expect(await favoriteMealFor(SOURCE, h)).toBeNull();
  });

  it("answers the id when the slot's meal IS a saved meal, while it is live", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const source = { ...SOURCE, mealId: `saved:${id}` };
    expect(await favoriteMealFor(source, h)).toBeNull();
    await putRow(h, "favorites_meals", id, { id, name: "Kept", sort: 1, rev: 1, deleted_at: null });
    expect(await favoriteMealFor(source, h)).toBe(id);
    // Saving that plate is then a no-op answering the same id.
    expect(await save({}, PLATE, source)).toEqual({ ok: true, id, newlyFavored: [], skipped: [] });
    expect(await allOps(h)).toEqual([]);
    await putRow(h, "favorites_meals", id, { id, name: "Kept", sort: 1, rev: 2,
      deleted_at: "2026-10-08T10:00:00.000Z" });
    expect(await favoriteMealFor(source, h)).toBeNull();
  });

  it("is null when signed out", async () => {
    expect(await favoriteMealFor(SOURCE, null)).toBeNull();
  });
});

describe("heart ON marks the plate's foods Favored", () => {
  const BANANA = component("Banana", 118, "food:banana-raw");
  const allowAll = (): FavorVerdict => "allowed";

  it("a closed account's Eats plate changes no mark, and its Eats only ever gain", async () => {
    const before = getFoods();
    const outcome = await save();
    expect(outcome).toMatchObject({ ok: true, newlyFavored: [], skipped: [] });
    expect(await membershipOps()).toEqual([]);
    const after = getFoods();
    for (const [id, food] of Object.entries(before)) {
      if (food.status === "eats") expect(after[id].status).toBe("eats");
    }
  });

  it("marks a newly allowed food with ONE eats membership op per name, never a star", async () => {
    const outcome = await save({ judge: allowAll }, [...PLATE, BANANA, { ...BANANA, qty: 50 }]);
    expect(outcome).toMatchObject({ ok: true, newlyFavored: ["banana"], skipped: [] });
    const ops = await membershipOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].payload).toMatchObject({ name_norm: "banana", status: "eats" });
    expect((await allOps(h)).some((op) => op.entity === "favorites_foods")).toBe(false);
    expect(readFoodMembership(h.userId, "banana")?.status).toBe("eats");
  });

  it("moves a neutral local food to Eats in the store too", async () => {
    const tofu = { ...food("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", "Tofu", "protein"), status: "neutral" as const };
    seedStore([FOODS[RICE_ID], FOODS[EGG_ID], tofu]);
    const outcome = await save({ judge: allowAll, foods: { ...FOODS, [tofu.id]: tofu } },
      [component("Tofu", 120, `food:${tofu.id}`)]);
    expect(outcome).toMatchObject({ ok: true, newlyFavored: ["tofu"] });
    expect(getFoods()[tofu.id].status).toBe("eats");
  });

  it("skips a food on Avoid and one blocked under the current rules (default judge)", async () => {
    const peanuts = { ...food("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", "Peanuts", "fat"), status: "avoid" as const };
    const shrimp = { ...food("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5", "Shrimp", "protein"), status: "neutral" as const };
    seedStore([FOODS[RICE_ID], FOODS[EGG_ID], peanuts, shrimp]);
    const foods = { ...FOODS, [peanuts.id]: peanuts, [shrimp.id]: shrimp };
    const outcome = await save({ foods, eligible: new Set([RICE_ID, EGG_ID]) }, [...PLATE,
      component("Peanuts", 20, `food:${peanuts.id}`), component("Shrimp", 90, `food:${shrimp.id}`)]);
    expect(outcome).toMatchObject({ ok: true, newlyFavored: [], skipped: ["peanuts", "shrimp"] });
    expect(await membershipOps()).toEqual([]);
    expect(getFoods()[peanuts.id].status).toBe("avoid");
    expect(getFoods()[shrimp.id].status).toBe("neutral");
  });

  it("skips what an injected rule check calls avoid or blocked", async () => {
    const outcome = await save({ judge: (_c, name) => name === "banana" ? "blocked" : "avoid" },
      [BANANA, component("Oats", 40, "catalog:777")]);
    expect(outcome).toMatchObject({ ok: true, newlyFavored: [], skipped: ["banana", "oats"] });
    expect(await membershipOps()).toEqual([]);
  });

  it("removing the saved meal (heart OFF) leaves every food Favored", async () => {
    const outcome = await save({ judge: allowAll }, [...PLATE, BANANA]);
    if (!outcome.ok) throw new Error("setup");
    const before = (await membershipOps()).length;
    expect(await removeFavoriteMeal(outcome.id, { account: h })).toMatchObject({ ok: true });
    expect(await membershipOps()).toHaveLength(before);
    expect(readFoodMembership(h.userId, "banana")?.status).toBe("eats");
  });
});

describe("undoSaveFavoriteMeal", () => {
  const BANANA = component("Banana", 118, "food:banana-raw");
  const allowAll = (): FavorVerdict => "allowed";

  it("removes the meal and puts back only its newly Favored names; an already-Favored food stays", async () => {
    const outcome = await save({ judge: allowAll }, [...PLATE, BANANA]);
    if (!outcome.ok) throw new Error("setup");
    // A caller that also names an already-Favored food never clears it: the save did not write it.
    const undone = await undoSaveFavoriteMeal(outcome.id, [...outcome.newlyFavored, "rice"], { account: h });
    expect(undone).toEqual({ ok: true, id: outcome.id, cleared: ["banana"], kept: ["rice"] });
    expect(readFoodMembership(h.userId, "banana")?.status).toBeNull();
    expect(getFoods()[RICE_ID].status).toBe("eats");
    expect((await getRow(h, "favorites_meals", outcome.id))?.deleted_at).toBeTruthy();
    const last = (await membershipOps()).at(-1);
    expect(last?.payload).toMatchObject({ name_norm: "banana", status: null });
  });

  it("puts a neutral local food back to neutral in the store", async () => {
    const tofu = { ...food("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", "Tofu", "protein"), status: "neutral" as const };
    seedStore([FOODS[RICE_ID], FOODS[EGG_ID], tofu]);
    const outcome = await save({ judge: allowAll, foods: { ...FOODS, [tofu.id]: tofu } },
      [component("Tofu", 120, `food:${tofu.id}`)]);
    if (!outcome.ok) throw new Error("setup");
    await undoSaveFavoriteMeal(outcome.id, outcome.newlyFavored, { account: h });
    expect(getFoods()[tofu.id].status).toBe("neutral");
  });

  it("never undoes a later mark of the same food", async () => {
    const outcome = await save({ judge: allowAll }, [...PLATE, BANANA]);
    if (!outcome.ok) throw new Error("setup");
    await setFoodMembership("Banana", "avoid", { account: h, note: null });
    await setFoodMembership("Banana", "eats", { account: h, note: null });
    const before = (await membershipOps()).length;
    const undone = await undoSaveFavoriteMeal(outcome.id, outcome.newlyFavored, { account: h });
    expect(undone).toMatchObject({ ok: true, cleared: [], kept: ["banana"] });
    expect(await membershipOps()).toHaveLength(before);
    expect(readFoodMembership(h.userId, "banana")?.status).toBe("eats");
  });

  it("is idempotent on retry: the same answer, and nothing more is written", async () => {
    const outcome = await save({ judge: allowAll }, [...PLATE, BANANA]);
    if (!outcome.ok) throw new Error("setup");
    const first = await undoSaveFavoriteMeal(outcome.id, outcome.newlyFavored, { account: h });
    const ops = (await allOps(h)).length;
    const second = await undoSaveFavoriteMeal(outcome.id, outcome.newlyFavored, { account: h });
    expect(second).toEqual(first);
    expect(await allOps(h)).toHaveLength(ops);
  });
});

// ------------------------------------------------------------------ Sol round 1 findings

type Record_ = { pending: { nameNorm: string; rev?: number }[]; done: { nameNorm: string; rev: number }[];
  skipped: string[] };
const marksOf = (id: string) => getMeta<Record_>(h, `favorite_meal_marks:${id}`);
const APPLE = component("Apple", 150, "food:apple-raw");
const BANANA_C = component("Banana", 118, "food:banana-raw");
const POOL: Record<string, Food> = {
  ...FOODS, "universe:apple-raw": food("universe:apple-raw", "Apple", "carb"),
};
const allow = (): FavorVerdict => "allowed";

/** An open account's verified set admitting the universe pool, as Today would hold it. */
function openSet(pool: Record<string, Food>): StampedEligibleSet {
  return new StampedEligibleSet(Object.keys(pool), new Map(), foodRulesKey(loadStore().settings),
    foodRulesEpoch(), undefined, Date.now(), h.userId, new Map(),
    { accountId: h.userId, computedAt: new Date().toISOString(), foods: pool } as never);
}

describe("#1 a tombstone and its op land together", () => {
  it("toggleFavorite: an op write that fails leaves the star untouched", async () => {
    const REF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await toggleFavorite("food", REF, undefined, { name: "Rice" });
    vi.mocked(outboxRow).mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(toggleFavorite("food", REF)).rejects.toThrow("disk full");
    expect((await getRow(h, "favorites_foods", REF))?.deleted_at).toBeNull();
    expect((await allOps(h)).map((op) => op.kind)).toEqual(["create"]);
  });

  it("removeFavoriteMeal: an op write that fails answers retry and keeps the meal and its heart", async () => {
    const a = await save();
    if (!a.ok) throw new Error("setup");
    vi.mocked(outboxRow).mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(await removeFavoriteMeal(a.id, { account: h })).toMatchObject({ ok: false, reason: "retry" });
    expect((await getRow(h, "favorites_meals", a.id))?.deleted_at).toBeNull();
    expect(await favoriteMealFor(SOURCE, h)).toBe(a.id);
    expect((await allOps(h)).map((op) => op.kind)).toEqual(["create"]);
  });
});

describe("#2 marks are resumable", () => {
  it("the meal commits with its pending marks; the next save call finishes them", async () => {
    const first = await save({ judge: () => "unverified" }, [...PLATE, BANANA_C]);
    expect(first).toMatchObject({ ok: true, newlyFavored: [], skipped: ["banana"] });
    if (!first.ok) throw new Error("setup");
    expect((await marksOf(first.id))?.pending.map((p) => p.nameNorm)).toEqual(["banana"]);
    const again = await save({ judge: allow }, [...PLATE, BANANA_C]);
    expect(again).toEqual({ ok: true, id: first.id, newlyFavored: ["banana"], skipped: [] });
    expect(await allRows(h, "favorites_meals")).toHaveLength(1);
    expect((await marksOf(first.id))?.pending).toEqual([]);
  });

  it("the post-sync run finishes them under a freshly verified set", async () => {
    const first = await save({ judge: () => "unverified" }, [...PLATE, BANANA_C]);
    if (!first.ok) throw new Error("setup");
    const loader = vi.fn(async () => openSet(FOODS));
    await resumeFavoriteMealMarks(h, getFoods(), loader);
    expect(loader).toHaveBeenCalledOnce();
    expect(readFoodMembership(h.userId, "banana")?.status).toBe("eats");
    expect((await marksOf(first.id))?.done.map((d) => d.nameNorm)).toEqual(["banana"]);
    // Nothing pending: no rules read at all.
    loader.mockClear();
    await resumeFavoriteMealMarks(h, getFoods(), loader);
    expect(loader).not.toHaveBeenCalled();
  });

  it("a failed rules read leaves the marks pending", async () => {
    const first = await save({ judge: () => "unverified" }, [...PLATE, BANANA_C]);
    if (!first.ok) throw new Error("setup");
    await resumeFavoriteMealMarks(h, getFoods(), async () => { throw new Error("offline"); });
    expect((await marksOf(first.id))?.pending.map((p) => p.nameNorm)).toEqual(["banana"]);
    expect(await membershipOps()).toEqual([]);
  });

  it("the default judge Favors an admitted universe food under an open set", async () => {
    const outcome = await save({ eligible: openSet(FOODS) }, [...PLATE, BANANA_C]);
    expect(outcome).toMatchObject({ ok: true, newlyFavored: ["banana"], skipped: [] });
  });
});

describe("#3 each meal keeps its own mark record", () => {
  it("two plates saved at once both keep every mark", async () => {
    const [a, b] = await Promise.all([
      save({ judge: allow, foods: POOL }, [BANANA_C]),
      save({ judge: allow, foods: POOL }, [APPLE], { ...SOURCE, mealId: "plate:other" }),
    ]);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect((await marksOf(a.id))?.done.map((d) => d.nameNorm)).toEqual(["banana"]);
    expect((await marksOf(b.id))?.done.map((d) => d.nameNorm)).toEqual(["apple"]);
  });
});

describe("#4 two tabs saving the same plate make one meal", () => {
  it("the write re-checks the source index and answers the other tab's meal", async () => {
    const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    // The other tab commits its meal for this plate after this tab's first check, while this tab
    // is still resolving refs.
    const racing = refs({ account: vi.fn(async (f: Food) => {
      if (!(await getRow(h, "favorites_meals", OTHER))) {
        await putRow(h, "favorites_meals", OTHER, { id: OTHER, name: "Rice and egg", sort: 1, rev: 1,
          deleted_at: null, items: [] });
        await putMeta(h, "favorite_meal_sources",
          { "2026-10-08|meal-1|plate:abc": { savedMealId: OTHER, savedAt: new Date().toISOString() } });
      }
      return f.id === RICE_ID ? RICE_REF : EGG_REF;
    }) });
    const outcome = await save({ refs: racing });
    expect(outcome).toMatchObject({ ok: true, id: OTHER });
    expect(await allRows(h, "favorites_meals")).toHaveLength(1);
    expect(await allOps(h)).toEqual([]);
  });
});

describe("#5 a rules change mid-run stops marking", () => {
  it("a name judged before the change stays pending; a later verdict under the new rules stands", async () => {
    let calls = 0;
    const judge = (): FavorVerdict => { calls += 1; if (calls === 1) noteFoodRulesChanged(); return "allowed"; };
    const first = await save({ judge, foods: POOL }, [BANANA_C, APPLE]);
    // Banana's verdict predates the change: no op, pending. Apple was judged under the new rules.
    expect(first).toMatchObject({ ok: true, newlyFavored: ["apple"], skipped: ["banana"] });
    if (!first.ok) throw new Error("setup");
    expect((await membershipOps()).map((op) => op.payload.name_norm)).toEqual(["apple"]);
    expect((await marksOf(first.id))?.pending.map((p) => p.nameNorm)).toEqual(["banana"]);
    const again = await save({ judge: allow, foods: POOL }, [BANANA_C, APPLE]);
    expect(again).toMatchObject({ newlyFavored: ["apple", "banana"], skipped: [] });
  });
});

describe("heart OFF drops pending marks", () => {
  it("no later run marks a removed meal's foods", async () => {
    const first = await save({ judge: () => "unverified" }, [...PLATE, BANANA_C]);
    if (!first.ok) throw new Error("setup");
    await removeFavoriteMeal(first.id, { account: h });
    const loader = vi.fn(async () => openSet(FOODS));
    await resumeFavoriteMealMarks(h, getFoods(), loader);
    expect(loader).not.toHaveBeenCalled();
    expect(readFoodMembership(h.userId, "banana")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ Sol round 2: the final check

describe("the final check before each Eats op", () => {
  it("Heart OFF while a run is in flight queues no Eats op and drops the pending marks", async () => {
    const first = await save({ judge: () => "unverified" }, [...PLATE, BANANA_C]);
    if (!first.ok) throw new Error("setup");
    let removal: Promise<unknown> | undefined;
    // The tap on the heart lands while the run is between its verdict and its op.
    const judge = (): FavorVerdict => { removal ??= removeFavoriteMeal(first.id, { account: h }); return "allowed"; };
    const again = await save({ judge }, [...PLATE, BANANA_C]);
    await removal;
    expect(again).toMatchObject({ ok: true, newlyFavored: [] });
    expect(await membershipOps()).toEqual([]);
    expect(readFoodMembership(h.userId, "banana")).toBeUndefined();
    expect((await marksOf(first.id))?.pending).toEqual([]);
  });

  it("a rules change during the run's awaits leaves the name pending, with no op", async () => {
    const judge = (): FavorVerdict => { queueMicrotask(() => noteFoodRulesChanged()); return "allowed"; };
    const first = await save({ judge, foods: POOL }, [BANANA_C]);
    expect(first).toMatchObject({ ok: true, newlyFavored: [], skipped: ["banana"] });
    if (!first.ok) throw new Error("setup");
    expect(await membershipOps()).toEqual([]);
    expect((await marksOf(first.id))?.pending.map((p) => p.nameNorm)).toEqual(["banana"]);
  });

  it("a rules change during the ref await revokes the set: nothing is marked", async () => {
    const eligible = openSet(FOODS);
    const bumping = refs({ bundled: vi.fn(async () => { noteFoodRulesChanged(); return UNI_REF; }) });
    const outcome = await save({ eligible, refs: bumping }, [...PLATE, BANANA_C]);
    expect(outcome).toMatchObject({ ok: true, newlyFavored: [], skipped: ["banana"] });
    expect(await membershipOps()).toEqual([]);
  });

  it("a stalled eligible read times out and leaves the marks pending", async () => {
    const first = await save({ judge: () => "unverified" }, [...PLATE, BANANA_C]);
    if (!first.ok) throw new Error("setup");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let called!: () => void;
      const asked = new Promise<void>((resolve) => { called = resolve; });
      const stalled = vi.fn(() => { called(); return new Promise<ReadonlySet<string>>(() => {}); });
      const run = resumeFavoriteMealMarks(h, getFoods(), stalled);
      await asked;
      await vi.advanceTimersByTimeAsync(6_000);
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect((await marksOf(first.id))?.pending.map((p) => p.nameNorm)).toEqual(["banana"]);
    expect(await membershipOps()).toEqual([]);
  });
});

// ------------------------------------------------------------------ Sol round 3: one atomic write

describe("the guarded write: check and write in one transaction", () => {
  it("an Avoid tap between the verdict and the write wins: no Eats op, the name is skipped", async () => {
    let tap: Promise<unknown> | undefined;
    const judge = (): FavorVerdict => {
      tap ??= setFoodMembership("Banana", "avoid", { account: h, note: null });
      return "allowed";
    };
    const first = await save({ judge, foods: POOL }, [BANANA_C]);
    await tap;
    if (!first.ok) throw new Error("setup");
    expect(first.newlyFavored).toEqual([]);
    expect((await membershipOps()).map((op) => op.payload.status)).toEqual(["avoid"]);
    expect(readFoodMembership(h.userId, "banana")?.status).toBe("avoid");
    // Whether this run saw the Avoid land or not, the next one skips the name for good.
    const again = await save({ judge: allow, foods: POOL }, [BANANA_C]);
    expect(again).toMatchObject({ newlyFavored: [], skipped: ["banana"] });
    expect((await marksOf(first.id))?.pending).toEqual([]);
    expect((await membershipOps()).map((op) => op.payload.status)).toEqual(["avoid"]);
  });

  it("a crash before the transaction commits writes nothing and leaves the name pending", async () => {
    const first = await save({ judge: () => "unverified", foods: POOL }, [BANANA_C]);
    if (!first.ok) throw new Error("setup");
    vi.mocked(outboxRow).mockImplementationOnce(() => { throw new Error("tab closed"); });
    const crashed = await save({ judge: allow, foods: POOL }, [BANANA_C]);
    expect(crashed).toMatchObject({ ok: true, newlyFavored: [], skipped: ["banana"] });
    expect(await membershipOps()).toEqual([]);
    expect(readFoodMembership(h.userId, "banana")).toBeUndefined();
    expect((await marksOf(first.id))?.pending.map((p) => p.nameNorm)).toEqual(["banana"]);
    expect((await marksOf(first.id))?.done).toEqual([]);
    // The revision it took was released: the next run writes.
    const again = await save({ judge: allow, foods: POOL }, [BANANA_C]);
    expect(again).toMatchObject({ newlyFavored: ["banana"] });
  });

  it("records exactly the op's revision, and Undo clears exactly that one", async () => {
    const first = await save({ judge: allow, foods: POOL }, [BANANA_C]);
    if (!first.ok) throw new Error("setup");
    const [op] = await membershipOps();
    const record = await marksOf(first.id);
    expect(record?.done).toEqual([{ nameNorm: "banana", rev: op.payload.rev }]);
    expect(record?.pending).toEqual([]);
    expect(readFoodMembership(h.userId, "banana")?.rev).toBe(op.payload.rev);
    const undone = await undoSaveFavoriteMeal(first.id, first.newlyFavored, { account: h });
    expect(undone).toMatchObject({ cleared: ["banana"], kept: [] });
    const ops = await membershipOps();
    expect(ops.at(-1)?.payload).toMatchObject({ name_norm: "banana", status: null });
    expect(Number(ops.at(-1)?.payload.rev)).toBeGreaterThan(Number(op.payload.rev));
  });

  it("Heart OFF between the verdict and the write: the guard refuses, nothing is queued", async () => {
    const first = await save({ judge: () => "unverified", foods: POOL }, [BANANA_C]);
    if (!first.ok) throw new Error("setup");
    let off: Promise<unknown> | undefined;
    const judge = (): FavorVerdict => { off ??= removeFavoriteMeal(first.id, { account: h }); return "allowed"; };
    const outcome = await save({ judge, foods: POOL }, [BANANA_C]);
    await off;
    expect(outcome).toMatchObject({ ok: true, newlyFavored: [] });
    expect(await membershipOps()).toEqual([]);
    expect(readFoodMembership(h.userId, "banana")).toBeUndefined();
    expect(await marksOf(first.id)).toMatchObject({ pending: [], done: [] });
  });
});

// ------------------------------------------------------------------ Sol round 4: done is the truth

/** The crash between the IndexedDB commit and the cache write: the cache never heard of it. */
function loseCachedMark(nameNorm: string): void {
  const stored = JSON.parse(localStorage.getItem(FOOD_PREF_REFS_KEY) ?? "{}") as Record<string, Record<string, unknown>>;
  delete stored[h.userId]?.[`membership:${nameNorm}`];
  localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify(stored));
  __resetFoodMembershipState();
}

describe("a crash between the commit and the cache write", () => {
  it("Undo still clears the mark from its done record, repairing the cache first", async () => {
    const first = await save({ judge: allow, foods: POOL }, [BANANA_C]);
    if (!first.ok) throw new Error("setup");
    const [op] = await membershipOps();
    loseCachedMark("banana");
    expect(readFoodMembership(h.userId, "banana")).toBeUndefined();
    const undone = await undoSaveFavoriteMeal(first.id, first.newlyFavored, { account: h });
    expect(undone).toMatchObject({ cleared: ["banana"], kept: [] });
    const last = (await membershipOps()).at(-1);
    expect(last?.payload).toMatchObject({ name_norm: "banana", status: null });
    expect(Number(last?.payload.rev)).toBeGreaterThan(Number(op.payload.rev));
    expect(readFoodMembership(h.userId, "banana")?.status).toBeNull();
  });

  it("the post-sync run repairs the cache from the done records", async () => {
    const first = await save({ judge: allow, foods: POOL }, [BANANA_C]);
    if (!first.ok) throw new Error("setup");
    const [op] = await membershipOps();
    loseCachedMark("banana");
    const loader = vi.fn(async () => openSet(POOL));
    await resumeFavoriteMealMarks(h, getFoods(), loader);
    expect(readFoodMembership(h.userId, "banana")).toMatchObject({ status: "eats", rev: op.payload.rev });
    expect(loader).not.toHaveBeenCalled(); // nothing pending: no rules read
  });

  it("never overwrites, or undoes, a newer cached choice", async () => {
    const first = await save({ judge: allow, foods: POOL }, [BANANA_C]);
    if (!first.ok) throw new Error("setup");
    await setFoodMembership("Banana", "avoid", { account: h, note: null });
    const avoidRev = readFoodMembership(h.userId, "banana")?.rev;
    await resumeFavoriteMealMarks(h, getFoods(), async () => openSet(POOL));
    expect(readFoodMembership(h.userId, "banana")).toMatchObject({ status: "avoid", rev: avoidRev });
    const undone = await undoSaveFavoriteMeal(first.id, first.newlyFavored, { account: h });
    expect(undone).toMatchObject({ cleared: [], kept: ["banana"] });
    expect(readFoodMembership(h.userId, "banana")?.status).toBe("avoid");
  });
});

// ------------------------------------------------------------------ Sol round 5

describe("an Avoid tap during the Undo await", () => {
  it("supersedes the neutral write: the name is kept, Avoid stands, the projection is untouched", async () => {
    const tofu = { ...food("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", "Tofu", "protein"), status: "neutral" as const };
    seedStore([FOODS[RICE_ID], FOODS[EGG_ID], tofu]);
    const first = await save({ judge: allow, foods: { ...FOODS, [tofu.id]: tofu } },
      [component("Tofu", 120, `food:${tofu.id}`)]);
    if (!first.ok) throw new Error("setup");
    expect(getFoods()[tofu.id].status).toBe("eats");
    // The tap lands after Undo reserved its neutral write and while that write awaits its id (the
    // first digest Undo asks for), before anything is queued.
    let tap: Promise<unknown> | undefined;
    let tapped = false;
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: () => real.randomUUID(),
      getRandomValues: <T extends ArrayBufferView>(a: T) => real.getRandomValues(a as never) as T,
      subtle: { digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if (!tapped) {
          tapped = true;
          tap = setFoodMembership("Tofu", "avoid", { account: h, note: null });
        }
        return real.subtle.digest(algorithm, data);
      } },
    });
    const undo = undoSaveFavoriteMeal(first.id, first.newlyFavored, { account: h });
    const undone = await undo;
    await tap;
    vi.stubGlobal("crypto", real);
    expect(tap).toBeDefined();
    expect(undone).toMatchObject({ ok: true, cleared: [], kept: ["tofu"] });
    expect((await membershipOps()).map((op) => op.payload.status)).toEqual(["eats", "avoid"]);
    expect(readFoodMembership(h.userId, "tofu")?.status).toBe("avoid");
    // The store projection was not reset to neutral by Undo (it is the Avoid tap's to move).
    expect(getFoods()[tofu.id].status).not.toBe("neutral");
    expect((await marksOf(first.id))?.done).toEqual([expect.not.objectContaining({ undone: true })]);
    // A retry of Undo still leaves the newer choice alone.
    expect(await undoSaveFavoriteMeal(first.id, first.newlyFavored, { account: h }))
      .toMatchObject({ cleared: [], kept: ["tofu"] });
  });
});
