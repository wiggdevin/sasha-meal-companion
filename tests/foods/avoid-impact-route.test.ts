import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ requireUser: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/server/auth", async (actual) => ({
  ...await actual<typeof import("@/lib/server/auth")>(), requireUser: mocked.requireUser,
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: mocked.rate }));

import { GET, POST } from "@/app/api/foods/avoid-impact/route";

function db(options: { selections?: Record<string, unknown>[]; days?: Record<string, unknown>[];
  refs?: Record<string, unknown>[] } = {}) {
  const selections = options.selections ?? [
    { local_date: "9999-01-01", slot_id: "meal-1", recipe_id: "recipe-a",
      recipe_name: "Peanut bowl", recipe_revision_id: "rev-a",
      ingredient_snapshot: [{ name: "peanuts" }, { name: "rice" }] },
    { local_date: "9999-01-02", slot_id: "meal-2", recipe_id: "recipe-b",
      recipe_name: "Peanut bowl eaten", recipe_revision_id: "rev-b",
      ingredient_snapshot: [{ name: "peanuts" }] },
  ];
  const days = options.days ?? [
    { local_date: "9999-01-01", eaten_slots: {}, item_overrides: {}, swaps: {} },
    { local_date: "9999-01-02", eaten_slots: { "meal-2": { eaten_at: "9999-01-02T12:00:00Z" } },
      item_overrides: {}, swaps: {} },
  ];
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "gte", "order"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = async () => ({ data: { time_zone: "UTC" }, error: null });
    chain.limit = async () => ({ data: table === "recipe_plan_selections" ? selections : days, error: null });
    chain.in = async () => ({ data: table === "food_refs" ? options.refs ?? [] : [], error: null });
    return chain;
  });
  return { from };
}

beforeEach(() => { mocked.requireUser.mockReset(); mocked.rate.mockReset(); });

describe("per-Avoid impact batch", () => {
  it("counts owner future instances per food and excludes consumed history", async () => {
    const client = db();
    mocked.requireUser.mockResolvedValue({ client, userId: "account-a" });
    const response = await POST(new Request("http://localhost/api/foods/avoid-impact", {
      method: "POST", body: JSON.stringify({ foods: [
        { id: "peanut", name: "peanut" }, { id: "chicken", name: "chicken" },
      ] }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ byId: {
      peanut: { count: 1, complete: true }, chicken: { count: 0, complete: true },
    } });
    expect(client.from).toHaveBeenCalledWith("recipe_plan_selections");
    expect(client.from).toHaveBeenCalledWith("plan_days");
  });

  it("uses base-name and bundled identity aliases for the same Avoid food", async () => {
    const client = db({ selections: [{ local_date: "9999-01-01", slot_id: "meal-1",
      recipe_id: "recipe-a", recipe_name: "Beans", recipe_revision_id: "rev-a",
      ingredient_snapshot: [{ name: "black beans", foodDbId: "black-beans-cooked" }] }] });
    mocked.requireUser.mockResolvedValue({ client, userId: "account-a" });
    const response = await POST(new Request("http://localhost/api/foods/avoid-impact", {
      method: "POST", body: JSON.stringify({ foods: [
        { id: "beans", name: "Black beans, cooked" },
      ] }),
    }));
    expect(await response.json()).toEqual({ byId: { beans: { count: 1, complete: true } } });
  });

  it("keeps missing and malformed snapshots as incomplete lower bounds", async () => {
    const client = db({ selections: [
      { local_date: "9999-01-01", slot_id: "meal-1", recipe_id: "r1",
        recipe_name: "Missing", recipe_revision_id: "v1", ingredient_snapshot: null },
      { local_date: "9999-01-01", slot_id: "meal-2", recipe_id: "r2",
        recipe_name: "Malformed", recipe_revision_id: "v2", ingredient_snapshot: [{}] },
    ] });
    mocked.requireUser.mockResolvedValue({ client, userId: "account-a" });
    const response = await POST(new Request("http://localhost/api/foods/avoid-impact", {
      method: "POST", body: JSON.stringify({ foods: [{ id: "peanut", name: "peanut" }] }),
    }));
    expect(await response.json()).toEqual({ byId: { peanut: { count: 0, complete: false } } });
  });

  it("matches a stored catalog food ref and ignores a removed swap", async () => {
    const client = db({ selections: [{ local_date: "9999-01-01", slot_id: "meal-1",
      recipe_id: "r1", recipe_name: "Beans", recipe_revision_id: "v1",
      ingredient_snapshot: [{ name: "mixed legumes", foodRefId: "ref-1" }] }],
    days: [{ local_date: "9999-01-01", eaten_slots: {},
      item_overrides: { "meal-2": { removed: true, cleared: true } },
      swaps: { "meal-2": "old-swap" } }],
    refs: [{ id: "ref-1", catalog_food_id: 42, user_food_id: null }] });
    mocked.requireUser.mockResolvedValue({ client, userId: "account-a" });
    const response = await POST(new Request("http://localhost/api/foods/avoid-impact", {
      method: "POST", body: JSON.stringify({ foods: [
        { id: "beans", name: "Black beans, cooked", catalogFoodId: 42 },
      ] }),
    }));
    expect(await response.json()).toEqual({ byId: { beans: { count: 1, complete: true } } });
    const detail = await GET(new Request("http://localhost/api/foods/avoid-impact?q=Black%20beans%2C%20cooked&kind=ingredient&catalogFoodId=42"));
    expect(detail.status).toBe(200);
    expect((await detail.json()).count).toBe(1);
  });

  it("accepts a legacy bundled food with null catalog ID", async () => {
    mocked.requireUser.mockResolvedValue({ client: db(), userId: "account-a" });
    const response = await POST(new Request("http://localhost/api/foods/avoid-impact", {
      method: "POST", body: JSON.stringify({ foods: [
        { id: "beans", name: "Black beans, cooked", catalogFoodId: null },
      ] }),
    }));
    expect(response.status).toBe(200);
  });

  it("does not count a recipe selection superseded by a swap", async () => {
    const client = db({ selections: [{ local_date: "9999-01-01", slot_id: "meal-1",
      recipe_id: "r1", recipe_name: "Peanut bowl", recipe_revision_id: "v1",
      ingredient_snapshot: [{ name: "peanuts" }] }],
    days: [{ local_date: "9999-01-01", eaten_slots: {},
      item_overrides: {}, swaps: { "meal-1": "replacement" } }] });
    mocked.requireUser.mockResolvedValue({ client, userId: "account-a" });
    const response = await POST(new Request("http://localhost/api/foods/avoid-impact", {
      method: "POST", body: JSON.stringify({ foods: [{ id: "peanut", name: "peanut" }] }),
    }));
    expect(await response.json()).toEqual({ byId: { peanut: { count: 0, complete: false } } });
  });
});
