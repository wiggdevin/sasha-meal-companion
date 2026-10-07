import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HAS_BRANCH, adminClient, ensureUser, resetUser, userClient, type TestUser } from "../helpers/supabase";
import { seedCatalogFood, seedUserFood, type Fixture } from "../log/fixtures";

const RECIPE = "88888888-8888-4888-8888-888888888888";

type Kind = "create" | "update" | "delete" | "restore";
type Result = Record<string, unknown> & { status: string };

async function op(
  client: SupabaseClient, userId: string, entity: string, entityId: string, kind: Kind,
  baseRev: number | null, payload: Record<string, unknown> = {},
): Promise<Result> {
  const { data, error } = await client.rpc("apply_sync_op", {
    p_user_id: userId,
    p_op: { op_id: crypto.randomUUID(), entity, entity_id: entityId, kind, base_rev: baseRev,
            payload, client_ts: new Date().toISOString() },
  });
  if (error) throw error;
  return data as Result;
}

/** One item at `grams` off the rice fixture, the shape both a recipe create and its edits use. */
function riceItems(rice: Fixture, grams: number): Record<string, unknown>[] {
  return [{ seq: 1, food_ref_id: rice.foodRefId, qty: 1, unit: "g", grams, state: "cooked" }];
}

/** food_refs row minted for a recipe's loggable twin (20260919090300, `_sync_upsert` "recipes"). */
async function recipeRefId(admin: SupabaseClient, recipeId: string): Promise<string> {
  const { data, error } = await admin.from("food_refs").select("id")
    .eq("user_food_id", recipeId).single();
  if (error) throw error;
  return data.id as string;
}

/**
 * User a, reset; the rice catalog fixture; one applied recipe create at RECIPE (4 servings, one
 * 400 g rice item); then one log_entries create whose single item is the recipe's food ref at
 * servingGrams (400 g ÷ 4 servings = 100 g) — the row AC 7 proves survives a later recipe edit
 * byte-identical.
 */
async function seedRecipe(): Promise<{ user: TestUser; client: SupabaseClient; rice: Fixture }> {
  const user = await ensureUser("a");
  await resetUser(user.id);
  const client = await userClient(user);
  const admin = adminClient();
  const rice = await seedCatalogFood(admin, user.id, { sourceId: "p3-rice",
    description: "Rice, white, cooked", per100g: { energy_kcal: 130, protein: 2.7,
      carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 } });
  const created = await op(client, user.id, "recipes", RECIPE, "create", null,
    { id: RECIPE, name: "Rice tray", servings: 4, items: riceItems(rice, 400) });
  if (created.status !== "applied") throw new Error(`seedRecipe: recipe create ${created.status}`);
  const foodRefId = await recipeRefId(admin, RECIPE);
  const logged = await op(client, user.id, "log_entries", crypto.randomUUID(), "create", null, {
    eaten_at: "2026-09-19T12:00:00-07:00", tz: "America/Los_Angeles", local_date: "2026-09-19",
    slot: "meal1", method: "search",
    items: [{ seq: 1, qty: 1, unit: "g", food_ref_id: foodRefId, grams: 100 }],
  });
  if (logged.status !== "applied") throw new Error(`seedRecipe: log entry create ${logged.status}`);
  return { user, client, rice };
}

describe.skipIf(!HAS_BRANCH)("phase 3 sync bookkeeping columns", () => {
  beforeAll(() => {
    /* migrations are applied by `pnpm db:push` before this suite runs */
  });

  it("gives every favorites table rev, created_at, updated_at and deleted_at", async () => {
    const admin = adminClient();
    for (const table of ["favorites_foods", "favorites_recipes"]) {
      const { error } = await admin
        .from(table)
        .select("rev, created_at, updated_at, deleted_at")
        .limit(1);
      expect([table, error]).toEqual([table, null]);
    }
    const meals = await admin
      .from("favorites_meals")
      .select("rev, created_at, updated_at, deleted_at")
      .limit(1);
    expect(meals.error).toBeNull();
  });

  it("gives recipes an updated_at", async () => {
    const { error } = await adminClient().from("recipes").select("updated_at").limit(1);
    expect(error).toBeNull();
  });

  it("gives user_settings a water goal that defaults to 8 and refuses 0 or 31", async () => {
    const admin = adminClient();
    const user = await ensureUser("a");
    await resetUser(user.id);
    const created = await admin
      .from("user_settings")
      .insert({ user_id: user.id, first_opened_at: new Date().toISOString() })
      .select("water_goal_cups")
      .single();
    expect(created.data?.water_goal_cups).toBe(8);
    const tooLow = await admin
      .from("user_settings")
      .update({ water_goal_cups: 0 })
      .eq("user_id", user.id);
    expect(tooLow.error).not.toBeNull();
    const tooHigh = await admin
      .from("user_settings")
      .update({ water_goal_cups: 31 })
      .eq("user_id", user.id);
    expect(tooHigh.error).not.toBeNull();
  });

  it("refuses an entity key that is not a uuid", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    const { data, error } = await client.rpc("apply_sync_op", {
      p_user_id: user.id,
      p_op: { op_id: crypto.randomUUID(), entity: "recipes", entity_id: "2026-09-19",
              kind: "create", base_rev: null, payload: {}, client_ts: new Date().toISOString() },
    });
    expect(data).toBeNull();   // the RPC raises bad_entity_key; supabase-js reports it in `error`
    expect(error?.message).toContain("bad_entity_key");
  });

  it("writes a recipe, its revision, its items, and a loggable user_foods twin", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    const rice = await seedCatalogFood(adminClient(), user.id, { sourceId: "p3-rice",
      description: "Rice, white, cooked", per100g: { energy_kcal: 130, protein: 2.7,
        carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 } });
    const applied = await op(client, user.id, "recipes", RECIPE, "create", null, {
      id: RECIPE, name: "Rice tray", servings: 4,
      items: [{ seq: 1, food_ref_id: rice.foodRefId, qty: 1, unit: "g", grams: 400, state: "cooked" }],
    });
    expect(applied).toMatchObject({ status: "applied", rev: 1 });

    const current = await adminClient().rpc("_sync_current", { p_user_id: user.id, p_entity: "recipes",
      p_key: RECIPE });
    expect(current.data.revision_rev).toBe(1);
    expect(current.data.nutrients_per_serving.energy_kcal).toBe(130);   // 520 kcal / 4
    expect(current.data.nutrients_per_serving.coverage).toBe(1);
    expect(current.data.food_ref_id).toEqual(expect.any(String));

    const twin = await adminClient().from("user_foods")
      .select("kind, per_100g").eq("id", RECIPE).single();
    expect(twin.data?.kind).toBe("recipe");
    expect(twin.data?.per_100g.energy_kcal).toBe(130);                  // 520 × 100 / 400 g
  });

  it("propagates the recipe's user_foods twin through sync_changes on create, edit and delete", async () => {
    // A pulling client only ever learns about a row from change_log (sync_changes reads nothing
    // else) — so the twin's own entry, alongside the recipe's, is what lets a second device's
    // local user_foods mirror learn this row exists at all.
    const { user, client, rice } = await seedRecipe();
    const admin = adminClient();
    const twinChanges = async () => {
      const { data, error } = await admin.rpc("sync_changes",
        { p_user_id: user.id, p_since: 0, p_limit: 500 });
      if (error) throw error;
      return (data as { entity: string; entity_key: string; rev: number; op: string;
        current: Record<string, unknown> | null }[])
        .filter((c) => c.entity === "user_foods" && c.entity_key === RECIPE);
    };

    const afterCreate = await twinChanges();
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0]).toMatchObject({ rev: 1, op: "create" });
    expect(afterCreate[0].current?.kind).toBe("recipe");

    await op(client, user.id, "recipes", RECIPE, "update", 1,
      { id: RECIPE, name: "Rice tray v2", servings: 4, items: riceItems(rice, 800) });
    const afterUpdate = await twinChanges();
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate[1]).toMatchObject({ rev: 2, op: "update" });

    await op(client, user.id, "recipes", RECIPE, "delete", 2, {});
    const afterDelete = await twinChanges();
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete[2]).toMatchObject({ rev: 3, op: "delete", current: null });
  });

  it("resolves the recipe's food ref via get_or_create_food_ref the moment its op is applied", async () => {
    // lib/recipes-client.ts's recipeFoodRefId() falls back to this same RPC when the local
    // mirror has not pulled the enriched `current` yet — proving the RPC already answers right
    // after the create (no pull needed) is what makes that fallback correct, not just plausible.
    const { user } = await seedRecipe();
    const admin = adminClient();
    const expected = await recipeRefId(admin, RECIPE);
    const resolved = await admin.rpc("get_or_create_food_ref",
      { p_user_id: user.id, p_kind: "user", p_catalog_food_id: null, p_user_food_id: RECIPE });
    expect(resolved.error).toBeNull();
    expect(resolved.data).toBe(expected);
  });

  it("an edit under a stale base_rev conflicts and writes nothing", async () => {
    const { user, client, rice } = await seedRecipe();
    await op(client, user.id, "recipes", RECIPE, "update", 1,
      { id: RECIPE, name: "Rice tray v2", servings: 4, items: riceItems(rice, 400) });
    const stale = await op(client, user.id, "recipes", RECIPE, "update", 1,
      { id: RECIPE, name: "Nope", servings: 4, items: riceItems(rice, 400) });
    expect(stale).toMatchObject({ status: "conflict", entity: "recipes", current_rev: 2 });
    const revs = await adminClient().from("recipe_revisions")
      .select("rev").eq("recipe_id", RECIPE).order("rev");
    expect(revs.data?.map((r) => r.rev)).toEqual([1, 2]);
  });

  it("an applied edit adds rev + 1 and leaves revision 1 and its log byte-identical", async () => {
    const { user, client, rice } = await seedRecipe();
    const admin = adminClient();
    const before = await admin.from("recipe_revisions")
      .select("id, rev, nutrients_per_serving").eq("recipe_id", RECIPE).eq("rev", 1).single();
    const logged = await admin.from("log_items").select("id, snapshot")
      .eq("food_ref_id", await recipeRefId(admin, RECIPE)).single();

    await op(client, user.id, "recipes", RECIPE, "update", 1,
      { id: RECIPE, name: "Rice tray", servings: 8, items: riceItems(rice, 400) });

    const after = await admin.from("recipe_revisions")
      .select("id, rev, nutrients_per_serving").eq("recipe_id", RECIPE).eq("rev", 1).single();
    expect(after.data).toEqual(before.data);
    const loggedAfter = await admin.from("log_items").select("id, snapshot")
      .eq("id", logged.data!.id).single();
    expect(loggedAfter.data).toEqual(logged.data);
  });

  it("reports coverage below 1, and never zero, for a nutrient one item does not measure", async () => {
    const { user, client, rice } = await seedRecipe();
    const admin = adminClient();
    const oil = await seedUserFood(admin, user.id,
      { name: "Olive oil", per100g: { energy_kcal: 884, protein: 0, carbohydrate: 0,
        fat_total: 100, fiber_total: null } });
    await op(client, user.id, "recipes", RECIPE, "update", 1, { id: RECIPE, name: "Rice tray",
      servings: 4, items: [...riceItems(rice, 400),
        { seq: 2, food_ref_id: oil.foodRefId, qty: 1, unit: "g", grams: 10, state: "raw" }] });
    const row = await admin.from("recipe_revisions")
      .select("nutrients_per_serving").eq("recipe_id", RECIPE).eq("rev", 2).single();
    const n = row.data!.nutrients_per_serving;
    expect(Number(n.coverage)).toBeLessThan(1);
    expect(Number(n.coverage)).toBeGreaterThan(0);
    expect(Number(n.fiber_total)).toBe(0.4);      // the rice's 1.6 g over 4 servings, not 0
  });

  it("accepts a current-revision correction from 5 cups to 3", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    await op(client, user.id, "water_log", "2026-09-19", "create", null, { cups: 5 });
    await op(client, user.id, "water_log", "2026-09-19", "update", 1, { cups: 3 });
    const row = await adminClient().from("water_log")
      .select("cups").eq("user_id", user.id).eq("local_date", "2026-09-19").single();
    expect(row.data?.cups).toBe(3); // 20261016090100: newer revisions allow corrections.
  });

  it("keeps both favorites when two clients each star a different food", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    const admin = adminClient();
    const a = await seedCatalogFood(admin, user.id, { sourceId: "fav-a", description: "Food A",
      per100g: { energy_kcal: 100 } });
    const b = await seedCatalogFood(admin, user.id, { sourceId: "fav-b", description: "Food B",
      per100g: { energy_kcal: 100 } });
    await op(client, user.id, "favorites_foods", a.foodRefId, "create", null,
      { food_ref_id: a.foodRefId, sort: 1 });
    await op(client, user.id, "favorites_foods", b.foodRefId, "create", null,
      { food_ref_id: b.foodRefId, sort: 2 });
    const rows = await admin.from("favorites_foods")
      .select("food_ref_id").eq("user_id", user.id).is("deleted_at", null);
    expect(rows.data?.length).toBe(2);
  });

  it("tombstones a favorite and refuses to resurrect it with a stale update", async () => {
    const { user, client, rice } = await seedRecipe();
    await op(client, user.id, "favorites_foods", rice.foodRefId, "create", null,
      { food_ref_id: rice.foodRefId, sort: 1 });
    const removed = await op(client, user.id, "favorites_foods", rice.foodRefId, "delete", 1, {});
    expect(removed).toMatchObject({ status: "applied", rev: 2 });
    const stale = await op(client, user.id, "favorites_foods", rice.foodRefId, "update", 1,
      { food_ref_id: rice.foodRefId, sort: 9 });
    expect(stale).toMatchObject({ status: "deleted" });
  });
});
