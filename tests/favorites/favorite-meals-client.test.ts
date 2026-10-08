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
