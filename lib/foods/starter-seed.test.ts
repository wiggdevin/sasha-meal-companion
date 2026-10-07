// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountHandle, bindAccount, unbindAccount } from "@/lib/device/account";
import { defaultStore } from "@/lib/store";
import type { SeedDependencies } from "./starter-seed";
import { remoteHasFoods as readRemoteHistory, seedZeroFoodAccount } from "./starter-seed";
import { persistStarterSelection } from "./starter-client";

const remoteReads = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({
  from: (table: string) => {
    remoteReads.tables.push(table);
    return { select: () => ({ eq: () => ({ limit: async () => ({
      data: table === "user_foods" ? [{ id: "deleted-starter" }] : [], error: null,
    }) }) }) };
  },
}) }));

const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
const owner = "11111111-1111-4111-8111-111111111111";
afterEach(() => unbindAccount());

function setup() {
  bindAccount(owner);
  const store = defaultStore();
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z",
    ruleReviewReady: true, activeTargetProfile: { revision: 1,
      training: { kcal: 2100, protein: 140, carbs: 245, fat: 62 },
      rest: { kcal: 2100, protein: 140, carbs: 245, fat: 62 },
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } };
  const marker = new Map<string, string>();
  const persist = vi.fn(async (..._args: Parameters<typeof persistStarterSelection>) => 1);
  const remoteHasFoods = vi.fn(async (): Promise<boolean | null> => false);
  const deps: SeedDependencies = { store: () => store, remoteHasFoods, persist,
    storage: { getItem: (key) => marker.get(key) ?? null,
      setItem: (key, value) => { marker.set(key, value); } } };
  return { store, persist, remoteHasFoods, marker, deps };
}

describe("zero-food starter seed", () => {
  it("treats a soft-deleted server food as account history on a second device", async () => {
    bindAccount(owner);
    remoteReads.tables.length = 0;
    expect(await readRemoteHistory(accountHandle())).toBe(true);
    expect(remoteReads.tables).toEqual(["user_foods", "user_food_prefs"]);
  });
  it("seeds one account once with a visible suggestion note and does not repeat", async () => {
    const { deps, persist, remoteHasFoods } = setup();
    expect(await seedZeroFoodAccount(profile, [], deps)).toBe(true);
    expect(await seedZeroFoodAccount(profile, [], deps)).toBe(false);
    expect(remoteHasFoods).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[3]).toBe("suggested");
  });

  it("fails closed for an unreviewed account or uncertain remote rows", async () => {
    const { deps, store, persist, remoteHasFoods } = setup();
    store.settings.ruleReviewReady = false;
    expect(await seedZeroFoodAccount(profile, [], deps)).toBe(false);
    expect(remoteHasFoods).not.toHaveBeenCalled();
    store.settings.ruleReviewReady = true;
    remoteHasFoods.mockResolvedValue(null);
    expect(await seedZeroFoodAccount(profile, [], deps)).toBe(false);
    remoteHasFoods.mockResolvedValue(true);
    expect(await seedZeroFoodAccount(profile, [], deps)).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("never seeds over current local choices", async () => {
    const { deps, store, remoteHasFoods } = setup();
    store.foods.own = { id: "own", name: "My lunch", role: "protein", unit: "g",
      perUnit: { protein: 1, carbs: 0, fat: 0 }, status: "eats", updatedAt: "2026-09-26" };
    expect(await seedZeroFoodAccount(profile, [], deps)).toBe(false);
    expect(remoteHasFoods).not.toHaveBeenCalled();
  });

  it("resumes a partial same-device seed without resetting an existing reviewed choice", async () => {
    const { deps, store, marker, remoteHasFoods } = setup();
    const persist = vi.fn(async (..._args: Parameters<typeof persistStarterSelection>) => {
      if (persist.mock.calls.length === 1) {
        store.foods.partial = { id: "partial", name: "Chicken breast, roasted", role: "protein",
          unit: "oz", perUnit: { protein: 8, carbs: 0, fat: 1 }, status: "avoid",
          updatedAt: "2026-09-27" };
        throw new Error("interrupted after first food");
      }
      return 1;
    });
    deps.persist = persist;
    await expect(seedZeroFoodAccount(profile, [], deps)).rejects.toThrow(/interrupted/);
    expect([...marker.values()]).toEqual(["pending"]);
    expect(await seedZeroFoodAccount(profile, [], deps)).toBe(true);
    expect(remoteHasFoods).toHaveBeenCalledTimes(1);
    expect([...marker.values()]).toEqual(["complete"]);
    expect(store.foods.partial.status).toBe("avoid");
  });
});
