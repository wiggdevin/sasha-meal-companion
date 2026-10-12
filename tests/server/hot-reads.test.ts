/**
 * W038: hot reads page or chunk past the API's 1,000-row cap and its request-line limit. The fake
 * answers like PostgREST: it filters, orders and slices by `.range()`, an unranged select stops at
 * 1,000 rows, every `.in()` list length is recorded, and a configured read answers an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/constraints", () => ({ getRuleReviewStatus: vi.fn(async () => ({ required: false })) }));
vi.mock("@/lib/server/policy-profile", () => ({
  readPolicyProfile: vi.fn(async () => ({ profile: EMPTY_PROFILE, rev: 1, instances: [] })),
}));

type Row = Record<string, unknown>;
const CAP = 1000;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** table → the 1-based read number that answers an error. */
  failOnRead: {} as Record<string, number>,
  reads: {} as Record<string, number>,
  /** The longest `.in()` list each table was asked for. */
  longestIn: {} as Record<string, number>,
}));

function fake(): SupabaseClient {
  return { from: (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const orders: string[] = [];
    let range: [number, number] | null = null;
    const answer = () => {
      state.reads[table] = (state.reads[table] ?? 0) + 1;
      if (state.failOnRead[table] === state.reads[table]) {
        return { data: null, error: { message: "synthetic outage" } };
      }
      const rows = (state.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      rows.sort((a, b) => {
        for (const column of orders) {
          const [x, y] = [String(a[column]), String(b[column])];
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      });
      const [from, to] = range ?? [0, CAP - 1];
      return { data: rows.slice(from, Math.min(to, from + CAP - 1) + 1), error: null };
    };
    const query: Record<string, unknown> = {
      select: () => query, or: () => query, limit: () => query,
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return query; },
      in: (column: string, values: unknown[]) => {
        state.longestIn[table] = Math.max(state.longestIn[table] ?? 0, values.length);
        const wanted = new Set(values.map(String));
        filters.push((row) => wanted.has(String(row[column])));
        return query;
      },
      order: (column: string) => { orders.push(column); return query; },
      range: (from: number, to: number) => { range = [from, to]; return query; },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject),
    };
    return query;
  } } as unknown as SupabaseClient;
}
vi.mock("@/lib/server/admin", () => ({ adminClient: () => fake() }));

const { IN_CHUNK_SIZE, fetchByKeyChunks } = await import("@/lib/server/paged-read");
const { foodsFor } = await import("@/lib/server/day-context");
const { eligibleFoods } = await import("@/lib/server/eligible-foods");
const { OCCASION_FACETS } = await import("@/lib/foods/facet-vocabulary");
const { facetRubricVersion } = await import("@/lib/foods/facets");
const { warmFoodCacheKey } = await import("@/lib/foods/facet-keys");

const USER = "account";
const pad = (n: number) => String(n).padStart(5, "0");

beforeEach(() => {
  state.tables = {};
  state.failOnRead = {};
  state.reads = {};
  state.longestIn = {};
});

/** `live` of the account's own foods on Eats (each with a ref and a cached human_food judgment),
 *  plus `deleted` soft-deleted foods that still carry a ref and an Eats pref. */
function seedFoods(live: number, deleted = 0): void {
  const ids = Array.from({ length: live + deleted }, (_, i) => `ee-${pad(i)}`);
  const isDeleted = (i: number) => i >= live;
  const food = (id: string, i: number) => ({ id: `uf-${id}`, user_id: USER, name: `Food ${id}`,
    per_100g: null, created_at: "2026-10-01T00:00:00Z", rev: 1, kind: "custom",
    deleted_at: isDeleted(i) ? "2026-10-02T00:00:00Z" : null });
  state.tables.user_foods = ids.map(food);
  state.tables.food_refs = ids.map((id, i) => ({ id, kind: "user", catalog_food_id: null,
    user_food_id: `uf-${id}`, user_foods: food(id, i) }));
  state.tables.user_food_prefs = ids.map((id) =>
    ({ user_id: USER, food_ref_id: id, status: "eats", role: null }));
  state.tables.food_facets = ids.flatMap((id) => {
    const key = warmFoodCacheKey({ identity: { kind: "user_food", id: `uf-${id}`, rev: 1 }, name: `Food ${id}` });
    return (["human_food", ...OCCASION_FACETS] as const).map((facet) => ({ food_key: key.foodKey,
      input_hash: key.inputHash, facet, rubric_version: facetRubricVersion(facet), p: 0.99,
      judged_at: "2026-10-01T00:00:00Z" }));
  });
}

describe("fetchByKeyChunks", () => {
  it("reads every key in bounded chunks and rejects on any failed chunk", async () => {
    state.tables.t = Array.from({ length: 400 }, (_, i) => ({ id: pad(i) }));
    const client = fake();
    const ids = state.tables.t.map((row) => row.id as string);
    const rows = await fetchByKeyChunks<string, Row>(ids, (batch) => client.from("t").select("id").in("id", batch));
    expect(rows).toHaveLength(400);
    expect(state.longestIn.t).toBeLessThanOrEqual(IN_CHUNK_SIZE);
    state.reads = {};
    state.failOnRead.t = 3;
    await expect(fetchByKeyChunks<string, Row>(ids, (batch) =>
      client.from("t").select("id").in("id", batch))).rejects.toThrow(/outage/);
  });
});

describe("foodsFor (lib/server/day-context.ts)", () => {
  it("returns every live food past 1,000 and skips soft-deleted ones", async () => {
    seedFoods(1500, 200);
    const foods = await foodsFor(fake(), USER);
    expect(Object.keys(foods)).toHaveLength(1500);
    expect(Object.values(foods).every((food) => food.status === "eats")).toBe(true);
    expect(foods["uf-ee-01600"]).toBeUndefined();
    expect(state.longestIn.food_refs).toBeLessThanOrEqual(IN_CHUNK_SIZE);
    expect(state.longestIn.user_food_prefs).toBeLessThanOrEqual(IN_CHUNK_SIZE);
  });

  it("rejects, never a shorter list, when a later page or chunk fails", async () => {
    seedFoods(1500);
    state.failOnRead.user_foods = 2;
    await expect(foodsFor(fake(), USER)).rejects.toThrow(/outage/);
    state.reads = {};
    delete state.failOnRead.user_foods;
    state.failOnRead.user_food_prefs = 4;
    await expect(foodsFor(fake(), USER)).rejects.toThrow(/outage/);
  });
});

describe("eligible Eats (lib/server/eligible-foods.ts)", () => {
  it("returns all 1,500 Eats foods, with every .in() list chunked", async () => {
    seedFoods(1500);
    const result = await eligibleFoods(fake(), USER);
    expect(result.excluded).toEqual([]);
    expect(result.eligibleRefIds).toHaveLength(1500);
    expect(result.eligibleFoodIds).toHaveLength(1500);
    for (const table of ["food_refs", "user_food_prefs"]) {
      expect(state.longestIn[table]).toBeLessThanOrEqual(IN_CHUNK_SIZE);
    }
  });

  it("rejects when a later food_refs chunk fails, never a shorter eligible set", async () => {
    seedFoods(1500);
    state.failOnRead.food_refs = 5;
    await expect(eligibleFoods(fake(), USER)).rejects.toThrow(/outage/);
  });

  it("marks nothing allowed when a later evidence chunk fails", async () => {
    seedFoods(1500);
    // eligibleFoods reads food_refs in 10 chunks; the evidence read's 4th chunk then fails.
    state.failOnRead.food_refs = 14;
    const result = await eligibleFoods(fake(), USER);
    expect(result.eligibleRefIds).toEqual([]);
    expect(result.excluded).toHaveLength(1500);
    expect(result.excluded.every((row) => row.verdict === "unknown")).toBe(true);
  });
});
