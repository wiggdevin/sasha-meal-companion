import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resetTestAccount } from "@/tests/helpers/account";
import { loadAccountFoodSnapshot, loadOwnedFoodRefs } from "./food-refs";
import { starterFood } from "@/lib/foods/starter";
import { uuidV5 } from "@/lib/foods/uuid5";

describe("account food ref lookup", () => {
  it("keeps only requested rows joined to the bound account", async () => {
    const account = await resetTestAccount();
    const filters: unknown[][] = [];
    const rows = [
      { id: "own-ref", user_food_id: "own-food", user_foods: { user_id: account.userId } },
      { id: "foreign-ref", user_food_id: "own-food", user_foods: { user_id: "other" } },
      { id: "extra-ref", user_food_id: "extra-food", user_foods: { user_id: account.userId } },
    ];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((...args: unknown[]) => { filters.push(args); return query; }),
      in: vi.fn((...args: unknown[]) => {
        filters.push(args);
        return Promise.resolve({ data: rows, error: null });
      }),
    };
    const client = { from: vi.fn(() => query) } as unknown as SupabaseClient;

    expect(await loadOwnedFoodRefs(account, ["own-food"], client)).toEqual([
      { id: "own-ref", user_food_id: "own-food" },
    ]);
    expect(filters).toContainEqual(["user_foods.user_id", account.userId]);
    expect(filters).toContainEqual(["user_food_id", ["own-food"]]);
  });
});

it("loads canonical Foods rows even without sync changes and discards another owner", async () => {
  const account = await resetTestAccount();
  const ownerFilters: unknown[][] = [];
  const userFoods = { select: vi.fn(() => userFoods), order: vi.fn(() => userFoods),
    limit: vi.fn(() => Promise.resolve({ data: [
      { id: "mine", user_id: account.userId, name: "Tofu", note: "No more than a cup",
        created_at: "2026-09-20" },
      { id: "theirs", user_id: "other", name: "Peanuts", created_at: "2026-09-20" },
    ], error: null })), eq: vi.fn((...args: unknown[]) => {
    ownerFilters.push(args);
    return userFoods;
  }) };
  const prefs = { select: vi.fn(() => prefs), order: vi.fn(() => prefs),
    limit: vi.fn(() => Promise.resolve({ data: [
      { food_ref_id: "ref-mine", user_id: account.userId, status: "eats" },
      { food_ref_id: "ref-theirs", user_id: "other", status: "avoid" },
    ], error: null })), eq: vi.fn((...args: unknown[]) => {
    ownerFilters.push(args);
    return prefs;
  }) };
  const refs = { select: vi.fn(() => refs), eq: vi.fn(() => refs),
    in: vi.fn(() => Promise.resolve({ data: [
      { id: "ref-mine", user_food_id: "mine", user_foods: { user_id: account.userId } },
      { id: "ref-theirs", user_food_id: "theirs", user_foods: { user_id: "other" } },
    ], error: null })) };
  const tables: Record<string, unknown> = {
    user_foods: userFoods, user_food_prefs: prefs, food_refs: refs,
  };
  const client = { from: vi.fn((table: string) => tables[table]) } as unknown as SupabaseClient;

  const snapshot = await loadAccountFoodSnapshot(account, client);
  expect(snapshot.foods.map((row) => row.id)).toEqual(["mine"]);
  expect(snapshot.foods[0].note).toBe("No more than a cup");
  expect(snapshot.prefs.map((row) => row.food_ref_id)).toEqual(["ref-mine"]);
  expect(snapshot.refs).toEqual([{ id: "ref-mine", user_food_id: "mine" }]);
  expect(ownerFilters).toEqual([["user_id", account.userId], ["user_id", account.userId]]);
  expect(userFoods.select).toHaveBeenCalledWith(expect.stringContaining("note"));
  expect(refs.in).toHaveBeenCalledWith("user_food_id", ["mine"]);
});

it("repairs the canonical legacy whey row before projecting Avoids", async () => {
  const account = await resetTestAccount();
  const food = starterFood("whey-protein-powder", "avoid");
  const id = await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    `legacy-food:${account.userId}:${food.id}`);
  const row = { id, user_id: account.userId, name: food.name, kind: "custom",
    brand: null, ingredients_text: null, allergen_tags: [], catalog_food_id: null,
    deleted_at: null, per_100g: {}, rev: 1, created_at: "2026-09-20" };
  const foodRead = { select: vi.fn(() => foodRead), eq: vi.fn(() => foodRead),
    order: vi.fn(() => foodRead),
    limit: vi.fn(() => Promise.resolve({ data: [row], error: null })) };
  const prefs = { select: vi.fn(() => prefs), eq: vi.fn(() => prefs),
    order: vi.fn(() => prefs),
    limit: vi.fn(() => Promise.resolve({ data: [{ user_id: account.userId,
      food_ref_id: "ref-whey", status: "avoid" }], error: null })) };
  const refs = { select: vi.fn(() => refs), eq: vi.fn(() => refs),
    in: vi.fn(() => Promise.resolve({ data: [{ id: "ref-whey", user_food_id: id,
      user_foods: { user_id: account.userId } }], error: null })) };
  const foodUpdate = { update: vi.fn(() => foodUpdate), eq: vi.fn(() => foodUpdate),
    is: vi.fn(() => foodUpdate), select: vi.fn(() => foodUpdate),
    maybeSingle: vi.fn(() => Promise.resolve({ data: { id, rev: 2 }, error: null })) };
  let foodCalls = 0;
  const client = { from: vi.fn((table: string) => table === "user_foods"
    ? (++foodCalls === 1 ? foodRead : foodUpdate)
    : table === "user_food_prefs" ? prefs : refs) } as unknown as SupabaseClient;

  const snapshot = await loadAccountFoodSnapshot(account, client);
  expect(snapshot.foods[0].per_100g?.energy_kcal).toBeGreaterThan(0);
  expect(snapshot.prefs[0].status).toBe("avoid");
  expect(foodUpdate.update).toHaveBeenCalledOnce();
});

it("reads every page of foods and preferences instead of silently stopping at 1,000", async () => {
  const account = await resetTestAccount();
  const allFoods = Array.from({ length: 1001 }, (_, i) => ({
    id: `food-${String(i).padStart(4, "0")}`, user_id: account.userId,
    name: `Food ${i}`, created_at: "2026-09-20",
  }));
  const allPrefs = Array.from({ length: 1001 }, (_, i) => ({
    food_ref_id: `ref-${String(i).padStart(4, "0")}`, user_id: account.userId,
    status: "eats",
  }));
  const cursors: Record<string, (string | null)[]> = { user_foods: [], user_food_prefs: [] };
  function paged(table: "user_foods" | "user_food_prefs", rows: unknown[]) {
    const key = table === "user_foods" ? "id" : "food_ref_id";
    let after: string | null = null;
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query),
      order: vi.fn(() => query), gt: vi.fn((_key: string, cursor: string) => {
        after = cursor;
        return query;
      }), limit: vi.fn((count: number) => {
        cursors[table].push(after);
        return Promise.resolve({ data: rows.filter((row) =>
          after === null || (row as Record<string, string>)[key] > after).slice(0, count),
        error: null });
      }) };
    return query;
  }
  const foods = paged("user_foods", allFoods);
  const prefs = paged("user_food_prefs", allPrefs);
  const refs = { select: vi.fn(() => refs), eq: vi.fn(() => refs),
    in: vi.fn(() => Promise.resolve({ data: [], error: null })) };
  const client = { from: vi.fn((table: string) => ({
    user_foods: foods, user_food_prefs: prefs, food_refs: refs,
  })[table]) } as unknown as SupabaseClient;
  const snapshot = await loadAccountFoodSnapshot(account, client);
  expect(snapshot.foods).toHaveLength(1001);
  expect(snapshot.prefs).toHaveLength(1001);
  expect(snapshot.foods.at(-1)?.id).toBe("food-1000");
  expect(snapshot.prefs.at(-1)?.food_ref_id).toBe("ref-1000");
  expect(cursors.user_foods).toEqual([null, "food-0999"]);
  expect(cursors.user_food_prefs).toEqual([null, "ref-0999"]);
  expect(foods.order).toHaveBeenCalledWith("id", { ascending: true });
  expect(prefs.order).toHaveBeenCalledWith("food_ref_id", { ascending: true });
  expect(foods.gt).toHaveBeenCalledWith("id", "food-0999");
  expect(prefs.gt).toHaveBeenCalledWith("food_ref_id", "ref-0999");
});
