import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { dropCatalogFoods, pointRequestClientAtBranch, seedCatalogFood, sessionCookieFor, uuid }
  from "../log/fixtures";

// lib/server/export.ts imports "server-only" (see tests/log/commit.test.ts for the precedent):
// only the marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { csvDocument } = await import("@/lib/export/csv");
const { decodeTextCursor, encodeTextCursor, FAVORITE_COLUMNS, favoriteRowValues,
  RECIPE_COLUMNS, recipeRowValues, WATER_COLUMNS, waterRowValues } = await import("@/lib/server/export");
const { GET } = await import("../../app/api/export/route");

describe("phase 3 export columns", () => {
  it("names the recipe columns the contract names, in order", () => {
    expect(RECIPE_COLUMNS).toEqual(["recipe_id", "name", "revision_rev", "created_at", "servings",
      "seq", "food_ref_id", "description", "grams", "energy_kcal", "protein_g",
      "carbohydrate_g", "fat_g", "fiber_g", "nutrition_coverage", "nutrition_complete"]);
    expect(FAVORITE_COLUMNS).toEqual(["kind", "id", "name", "sort", "added_at"]);
    expect(WATER_COLUMNS).toEqual(["local_date", "cups", "goal", "goal_training_cups",
      "goal_rest_cups"]);
  });

  it("maps a row into column order and leaves an unmeasured nutrient null", () => {
    const values = recipeRowValues({ recipe_id: "r1", name: "Rice tray", revision_rev: 2,
      created_at: "2026-09-19T10:00:00.000Z", servings: 4, seq: 1, food_ref_id: "ref",
      description: "Rice, white, cooked", grams: 400, energy_kcal: 130, protein_g: 2.7,
      carbohydrate_g: 28, fat_g: 0.3, fiber_g: null,
      nutrition_coverage: 0.5, nutrition_complete: false });
    expect(values.at(0)).toBe("r1");
    expect(values.at(-3)).toBeNull();
    // #21: a partial revision says so in the export rather than passing as a full serving.
    expect(values.slice(-2)).toEqual([0.5, "false"]);
  });

  it("guards a formula-leading favorite name and trails the ODbL notice", () => {
    const csv = csvDocument(FAVORITE_COLUMNS,
      [favoriteRowValues({ kind: "food", id: "f1", name: "=cmd|calc", sort: 1,
        added_at: "2026-09-19T10:00:00.000Z" })],
      ["Data from Open Food Facts, licensed under the Open Database License (ODbL)."]);
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain("# Data from Open Food Facts");
  });

  it("round-trips a text cursor and refuses a malformed one", () => {
    expect(decodeTextCursor(encodeTextCursor("food:f1"))).toBe("food:f1");
    expect(() => decodeTextCursor("%%%")).toThrow();
  });

  it("reports water with the count, the day's goal and both day-type goals", () => {
    expect(waterRowValues({ local_date: "2026-09-19", cups: 5, goal: 8, goal_training_cups: 10,
      goal_rest_cups: 7 }))
      .toEqual(["2026-09-19", 5, 8, 10, 7]);
  });
});

async function op(client: SupabaseClient, userId: string, entity: string, entityId: string,
  kind: "create" | "update" | "delete" | "restore", baseRev: number | null,
  payload: Record<string, unknown> = {}): Promise<{ status: string }> {
  const { data, error } = await client.rpc("apply_sync_op", {
    p_user_id: userId,
    p_op: { op_id: crypto.randomUUID(), entity, entity_id: entityId, kind, base_rev: baseRev,
      payload, client_ts: new Date().toISOString() },
  });
  if (error) throw error;
  return data as { status: string };
}

function get(query: string, cookie?: string): Request {
  return new Request(`https://app.test/api/export?${query}`,
    { headers: cookie ? { cookie, ...accountHeaderFromCookie(cookie) } : {} });
}

const run = HAS_BRANCH ? describe : describe.skip;
const RECIPE = uuid(9001);

run("GET /api/export?kind=recipes", () => {
  let cookieA = "";
  let cookieB = "";
  let admin: SupabaseClient;

  beforeAll(async () => {
    pointRequestClientAtBranch();
    const users = await createTestUsers();
    admin = users.admin;
    const rice = await seedCatalogFood(admin, users.a.userId, { sourceId: "p3-kinds-rice",
      description: "Rice, white, cooked", per100g: { energy_kcal: 130, protein: 2.7,
        carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 } });
    const created = await op(users.a.client, users.a.userId, "recipes", RECIPE, "create", null,
      { id: RECIPE, name: "Rice tray", servings: 4,
        items: [{ seq: 1, food_ref_id: rice.foodRefId, qty: 1, unit: "g", grams: 400,
          state: "cooked" }] });
    if (created.status !== "applied") {
      throw new Error(`seed recipe create: ${created.status}`);
    }
    cookieA = await sessionCookieFor(users.a.client);
    cookieB = await sessionCookieFor(users.b.client);
  });

  afterAll(async () => {
    // recipes and its own loggable twin (user_foods/food_refs sharing the recipe's id, minted by
    // _sync_upsert "recipes") are not reached by dropCatalogFoods' food-ref cleanup.
    await admin.from("recipes").delete().eq("id", RECIPE);
    await admin.from("user_foods").delete().eq("id", RECIPE).eq("kind", "recipe");
    await dropCatalogFoods(admin, "p3-kinds-");
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("streams the recipe's revision items as CSV, and hides them from another user", async () => {
    const res = await GET(get("kind=recipes&format=csv", cookieA));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe(RECIPE_COLUMNS.join(","));
    // User a's shared branch fixture also carries other lanes' recipes, so this asserts our row
    // is present rather than that it is the only one.
    expect(lines.some((line) => line.startsWith(`${RECIPE},Rice tray,1,`))).toBe(true);

    const other = await GET(get("kind=recipes&format=json", cookieB));
    expect(other.status).toBe(200);
    const body = await other.json();
    expect(body.rows).toEqual([]);
  });
});

run("GET /api/export?kind=favorites", () => {
  let cookieA = "";
  let cookieB = "";
  let admin: SupabaseClient;
  let foodRefId = "";

  beforeAll(async () => {
    pointRequestClientAtBranch();
    const users = await createTestUsers();
    admin = users.admin;
    const rice = await seedCatalogFood(admin, users.a.userId, { sourceId: "p3-fav-rice",
      description: "White rice", per100g: { energy_kcal: 130, protein: 2.7,
        carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 } });
    foodRefId = rice.foodRefId;
    const created = await op(users.a.client, users.a.userId, "favorites_foods", foodRefId,
      "create", null, { food_ref_id: foodRefId, sort: 1 });
    if (created.status !== "applied") {
      throw new Error(`seed favorite create: ${created.status}`);
    }
    cookieA = await sessionCookieFor(users.a.client);
    cookieB = await sessionCookieFor(users.b.client);
  });

  afterAll(async () => {
    await admin.from("favorites_foods").delete().eq("food_ref_id", foodRefId);
    await dropCatalogFoods(admin, "p3-fav-");
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("streams a starred food as CSV, and hides it from another user", async () => {
    const res = await GET(get("kind=favorites&format=csv", cookieA));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe(FAVORITE_COLUMNS.join(","));
    // User a's shared branch fixture also carries other lanes' favorites, so this asserts our
    // row is present rather than that it is the only one.
    expect(lines.some((line) => line.startsWith(`food,${foodRefId},White rice,1,`)))
      .toBe(true);

    const other = await GET(get("kind=favorites&format=json", cookieB));
    expect(other.status).toBe(200);
    const body = await other.json();
    expect(body.rows).toEqual([]);
  });
});

run("GET /api/export?kind=water", () => {
  const DATE = "2099-12-31";
  let cookieA = "";
  let cookieB = "";
  let admin: SupabaseClient;

  beforeAll(async () => {
    pointRequestClientAtBranch();
    const users = await createTestUsers();
    admin = users.admin;
    const created = await op(users.a.client, users.a.userId, "water_log", DATE, "create", null,
      { cups: 5 });
    if (created.status !== "applied") {
      throw new Error(`seed water create: ${created.status}`);
    }
    cookieA = await sessionCookieFor(users.a.client);
    cookieB = await sessionCookieFor(users.b.client);
  });

  afterAll(async () => {
    await admin.from("water_log").delete().eq("local_date", DATE);
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("streams a day's cups with the goal as CSV, and hides it from another user", async () => {
    const res = await GET(get(`kind=water&from=${DATE}&to=${DATE}&format=csv`, cookieA));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe(WATER_COLUMNS.join(","));
    expect(lines.some((line) => line.startsWith(`${DATE},5,`))).toBe(true);

    const other = await GET(get(`kind=water&from=${DATE}&to=${DATE}&format=json`, cookieB));
    expect(other.status).toBe(200);
    const body = await other.json();
    expect(body.rows).toEqual([]);
  });
});
