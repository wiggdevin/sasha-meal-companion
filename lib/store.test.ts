import { describe, expect, it } from "vitest";
import { defaultStore, foodsFromSyncRows, migrateExtraItems } from "./store";
import type { LoggedFood } from "./types";
import { resetTestAccount } from "@/tests/helpers/account";

function fakeBrowser(initialRaw: string) {
  const state = { saved: initialRaw, shouldThrow: false };
  const localStorage = {
    getItem: () => state.saved,
    setItem: (_key: string, value: string) => {
      if (state.shouldThrow) throw new Error("QuotaExceededError");
      state.saved = value;
    },
  };
  return { state, window: { localStorage } };
}

const legacyMeal = {
  id: "m1", foodId: "meal", name: "Chipotle bowl", portionLabel: "2 items", qty: 1, grams: 400,
  macros: { kcal: 700, protein: 40, carbs: 80, fat: 20 }, at: "2026-09-11T18:00:00.000Z",
  items: [
    { id: "a", foodId: "rice", name: "White rice", portionLabel: "1 cup", qty: 1, grams: 180,
      macros: { kcal: 234, protein: 5, carbs: 51, fat: 0 }, at: "2026-09-11T18:00:00.000Z" },
    { id: "b", foodId: "chicken", name: "Chicken", portionLabel: "3 oz", qty: 2, grams: 170,
      macros: { kcal: 280, protein: 52, carbs: 0, fat: 6 }, at: "2026-09-11T18:00:00.000Z" },
  ],
} as unknown as LoggedFood;

describe("migrateExtraItems", () => {
  it("backfills the Phase 2 half of every legacy meal item and keeps the display half", () => {
    const { extras, changed } = migrateExtraItems([legacyMeal]);
    expect(changed).toBe(true);
    const items = extras[0].items!;
    expect(items.map((i) => i.seq)).toEqual([1, 2]);
    expect(items[0]).toMatchObject({
      food_ref_id: "local:rice", unit: "portion", grams: 180,
      name: "White rice", portionLabel: "1 cup",
    });
    expect(items[0].snapshot).toEqual({});
    expect(items[0].macros.kcal).toBe(234);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = migrateExtraItems([legacyMeal]);
    const twice = migrateExtraItems(once.extras);
    expect(twice.changed).toBe(false);
    expect(twice.extras).toEqual(once.extras);
  });

  it("leaves a Phase 2 entry alone", () => {
    const modern = {
      id: "e1", foodId: "catalog:41", name: "Chicken breast", portionLabel: "140 g", qty: 140,
      grams: 140, macros: { kcal: 231, protein: 43.4, carbs: 0, fat: 5 }, at: "2026-09-11T18:00:00.000Z",
      items: [{ id: "i1", seq: 1, food_ref_id: "uuid-1", grams: 140, qty: 140, unit: "g",
                snapshot: { protein: { amount: 43.4, unit: "g", basis: "per_100g",
                            source: "fdc_sr_legacy", source_version: "2026-04", revision_id: 910 } },
                name: "Chicken breast", portionLabel: "140 g",
                macros: { kcal: 231, protein: 43.4, carbs: 0, fat: 5 } }],
    } as unknown as LoggedFood;
    const { extras, changed } = migrateExtraItems([modern]);
    expect(changed).toBe(false);
    expect(extras[0].items![0].food_ref_id).toBe("uuid-1");
  });

  it("leaves a single-food extra with no items alone", () => {
    const single = { id: "s", foodId: "banana", name: "Banana", portionLabel: "1 medium", qty: 1,
      grams: 118, macros: { kcal: 105, protein: 1, carbs: 27, fat: 0 }, at: "2026-09-11T08:00:00.000Z" } as LoggedFood;
    const { extras, changed } = migrateExtraItems([single]);
    expect(changed).toBe(false);
    expect(extras[0].items).toBeUndefined();
  });
});

describe("account food projection", () => {
  it("starts a fresh device with no bundled foods", () => {
    expect(defaultStore().foods).toEqual({});
  });

  it("joins schema-shaped food rows through owned refs and leaves unmapped rows neutral", () => {
    const foods = foodsFromSyncRows([
      { id: "food-a", name: "Mapped food",
        per_100g: { protein: 20, carbohydrate: 10, fat_total: 5 } },
      { id: "food-b", name: "Neutral food", per_100g: {} },
    ], [
      { food_ref_id: "ref-a", status: "eats", role: "protein", no_cook: true,
        updated_at: "2026-09-20T12:00:00Z" },
      { food_ref_id: "foreign-ref", status: "avoid", role: "fat" },
    ], [{ id: "ref-a", user_food_id: "food-a" },
      { id: "foreign-ref", user_food_id: "someone-elses-food" }]);
    expect(foods["food-a"]).toMatchObject({ unit: "g", status: "eats", role: "protein",
      perUnit: { protein: 0.2, carbs: 0.1, fat: 0.05 }, noCook: true });
    expect(foods["food-b"]).toMatchObject({ status: "neutral", role: "carb" });
  });

  it("rehydrates a synced starter with its role and household portion", () => {
    const foods = foodsFromSyncRows([{ id: "server-tofu", name: "Tofu, firm",
      per_100g: { protein: 10, carbohydrate: 2, fat_total: 5 } }],
    [{ food_ref_id: "ref-tofu", status: "eats" }],
    [{ id: "ref-tofu", user_food_id: "server-tofu" }]);
    expect(foods["server-tofu"]).toMatchObject({ status: "eats", role: "protein", unit: "oz" });
    expect(foods["server-tofu"].perUnit.protein).toBeCloseTo(2.835);
  });

  it("keeps an authored note on a neutral food with no preference row", () => {
    const foods = foodsFromSyncRows([
      { id: "neutral-food", name: "White rice", note: "Only a little", per_100g: {} },
    ], []);
    expect(foods["neutral-food"]).toMatchObject({ status: "neutral", note: "Only a little" });
  });
});

describe("saveStore / loadStore — a failed localStorage write is not silently reverted", () => {
  it("keeps a pending write in memory when setItem throws, instead of loadStore reverting to the stale blob", async () => {
    const { __resetStoreCache, loadStore, updateDay } = await import("./store");
    __resetStoreCache();
    const initial = JSON.stringify({
      version: 1,
      firstOpenedAt: "2026-09-01T00:00:00.000Z",
      settings: {},
      days: {},
      foods: {},
    });
    const { state, window: fakeWindow } = fakeBrowser(initial);
    const g = globalThis as unknown as { window?: unknown };
    g.window = fakeWindow;
    try {
      // Establish the initial in-memory/on-disk state.
      loadStore();

      // From here on, every localStorage write fails (quota exceeded,
      // private browsing, storage disabled).
      state.shouldThrow = true;

      updateDay("2026-09-13", { eaten: { "meal-1": "2026-09-13T08:00:00.000Z" } });

      // The write never reached localStorage...
      expect(state.saved).toBe(initial);

      // ...but the next loadStore() call (exactly what Today()'s render body
      // does on every re-render) must not silently discard the pending tick.
      const reloaded = loadStore();
      expect(reloaded.days["2026-09-13"]?.eaten?.["meal-1"]).toBe("2026-09-13T08:00:00.000Z");
    } finally {
      delete g.window;
      __resetStoreCache();
    }
  });
});

describe("loadStore keeps the in-memory food projection across re-reads", () => {
  it("does not wipe foods that replaceFoodsFromSync projected when loadStore re-reads storage", async () => {
    const { __resetStoreCache, loadStore, replaceFoodsFromSync } = await import("./store");
    __resetStoreCache();
    const initial = JSON.stringify({
      version: 1, firstOpenedAt: "2026-09-01T00:00:00.000Z", settings: {}, days: {}, foods: {},
    });
    const { window: fakeWindow } = fakeBrowser(initial);
    const g = globalThis as unknown as { window?: unknown };
    g.window = fakeWindow;
    try {
      loadStore();
      const h = await resetTestAccount();
      replaceFoodsFromSync(
        h,
        [{ id: "food-a", name: "Eggs", per_100g: { kcal: 155, protein: 13, carbs: 1, fat: 11 } }],
        [],
      );
      // MyFoods calls loadStore() on mount; the projection must still be there.
      expect(loadStore().foods["food-a"]).toMatchObject({ name: "Eggs" });
    } finally {
      delete g.window;
      __resetStoreCache();
    }
  });
});

describe("loadStore never restores foods from the unscoped local blob (design §7.1)", () => {
  it("starts with no foods on a cold read even when the persisted JSON carries some", async () => {
    const { __resetStoreCache, loadStore } = await import("./store");
    __resetStoreCache();
    const persisted = JSON.stringify({
      version: 1, firstOpenedAt: "2026-09-01T00:00:00.000Z", settings: {}, days: {},
      foods: { "food-a": { id: "food-a", name: "Eggs", role: "protein", unit: "g",
        perUnit: { protein: 13, carbs: 1, fat: 11 }, status: "eats", noCook: false } },
    });
    const { window: fakeWindow } = fakeBrowser(persisted);
    const g = globalThis as unknown as { window?: unknown };
    g.window = fakeWindow;
    try {
      expect(loadStore().foods).toEqual({});
    } finally {
      delete g.window;
      __resetStoreCache();
    }
  });
});

describe("loadStore drops the retired scale-warning key (R2)", () => {
  /**
   * The first-week scale warning was one account's history shown to every new one, so the card, its
   * mount and its store field are gone. A phone that still holds the old blob must keep working:
   * normalizeStore rebuilds the store from the fields it still has, and the retired key simply does
   * not come back — no crash, no resurrected state.
   */
  it("reads an old blob that still carries scaleWarningDismissed and leaves the key behind", async () => {
    const { __resetStoreCache, loadStore } = await import("./store");
    __resetStoreCache();
    const persisted = JSON.stringify({
      version: 1, firstOpenedAt: "2026-09-01T00:00:00.000Z", scaleWarningDismissed: true,
      settings: {}, days: {}, foods: {},
    });
    const { window: fakeWindow } = fakeBrowser(persisted);
    const g = globalThis as unknown as { window?: unknown };
    g.window = fakeWindow;
    try {
      const store = loadStore() as unknown as Record<string, unknown>;
      expect("scaleWarningDismissed" in store).toBe(false);
      expect(store.firstOpenedAt).toBe("2026-09-01T00:00:00.000Z");
    } finally {
      delete g.window;
      __resetStoreCache();
    }
  });
});
