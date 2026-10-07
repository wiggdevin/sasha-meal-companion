import { beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, adminClient, ensureUser, resetUser, userClient, type TestUser,
} from "../helpers/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const USER_TABLES = [
  "user_foods", "user_food_prefs", "log_entries", "water_log", "plan_days", "user_settings",
  "gut_log", "recipes", "recipe_revisions", "recipe_items", "favorites_foods", "favorites_recipes",
  "favorites_meals", "favorites_meal_items",
  "target_profiles", "expenditure_estimates", "target_proposals", "constraint_profiles",
  "coach_threads", "coach_messages", "ai_calls", "api_tokens", "health_sources", "ingest_events",
  "health_samples",
  "change_seq", "change_log", "duplicate_groups", "log_items", "duplicate_group_members",
  "weigh_ins",
] as const;

describe.skipIf(!HAS_BRANCH)("cross-user denial", () => {
  let a: TestUser;
  let b: TestUser;
  let bClient: SupabaseClient;
  let foodId: string;
  let tokenId: string;
  let recipeId: string;
  let recipeRevisionId: string;
  let mealId: string;
  let threadId: string;
  let refId: string;

  beforeAll(async () => {
    a = await ensureUser("a");
    b = await ensureUser("b");
    await resetUser(a.id);
    await resetUser(b.id);
    const admin = adminClient();

    foodId = "11111111-1111-4111-8111-111111111111";
    const ops = [
      { entity: "user_foods", entity_id: foodId, payload: { name: "Chicken", kind: "custom" } },
      { entity: "water_log", entity_id: "2026-09-11", payload: { cups: 3 } },
      { entity: "plan_days", entity_id: "2026-09-11", payload: { floor_day: true } },
      { entity: "gut_log", entity_id: "22222222-2222-4222-8222-222222222222",
        payload: { local_date: "2026-09-11", tz: "America/New_York", state: "good" } },
      { entity: "user_settings", entity_id: "settings",
        payload: { first_opened_at: new Date().toISOString() } },
    ];
    for (const op of ops) {
      const { data, error } = await admin.rpc("apply_sync_op", {
        p_user_id: a.id,
        p_op: { op_id: crypto.randomUUID(), kind: "create", base_rev: null,
                client_ts: new Date().toISOString(), ...op },
      });
      expect(error).toBeNull();
      expect((data as { status: string }).status).toBe("applied");
    }

    const source = await admin.from("health_sources")
      .insert({ user_id: a.id, kind: "manual", device_label: "typed" }).select("id").single();
    expect(source.error).toBeNull();
    const sample = await admin.from("health_samples").insert({
      user_id: a.id, source_id: source.data!.id, type: "body_mass", value: 140, unit: "lb",
      start_time: "2026-09-11T12:00:00Z", end_time: "2026-09-11T12:00:00Z", tz: "America/New_York",
    });
    expect(sample.error).toBeNull();

    const token = await admin.from("api_tokens").insert({
      user_id: a.id, label: "codex", token_hash: Buffer.from("a".repeat(32)),
    }).select("id").single();
    expect(token.error).toBeNull();
    tokenId = token.data!.id;

    // Child tables reached through a parent existence check (§2.1 pattern 2): recipes ->
    // recipe_revisions -> recipe_items, favorites_meals -> favorites_meal_items, and
    // coach_threads -> coach_messages. Seed one row per table so RLS has something to hide.
    refId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const foodRef = await admin.from("food_refs")
      .insert({ id: refId, kind: "user", user_food_id: foodId }).select("id").single();
    expect(foodRef.error).toBeNull();

    recipeId = "88888888-8888-4888-8888-888888888888";
    const recipe = await admin.from("recipes")
      .insert({ id: recipeId, name: "Bowl", user_id: a.id, servings: 1 }).select("id").single();
    expect(recipe.error).toBeNull();
    recipeRevisionId = "99999999-9999-4999-8999-999999999999";
    const revision = await admin.from("recipe_revisions")
      .insert({ id: recipeRevisionId, recipe_id: recipeId, rev: 1 }).select("id").single();
    expect(revision.error).toBeNull();
    const item = await admin.from("recipe_items").insert({
      recipe_revision_id: recipeRevisionId, seq: 1, qty: 1, unit: "cup", food_ref_id: refId,
      grams: 100,
    });
    expect(item.error).toBeNull();

    mealId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const meal = await admin.from("favorites_meals")
      .insert({ id: mealId, name: "Lunch", user_id: a.id }).select("id").single();
    expect(meal.error).toBeNull();
    const mealItem = await admin.from("favorites_meal_items")
      .insert({ meal_id: mealId, seq: 1, food_ref_id: refId, grams: 100 });
    expect(mealItem.error).toBeNull();

    threadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const thread = await admin.from("coach_threads")
      .insert({ id: threadId, user_id: a.id, title: "Check-in" }).select("id").single();
    expect(thread.error).toBeNull();
    // Phase 7 (lane R) denormalises user_id onto coach_messages and numbers rows by seq;
    // both are NOT NULL after that migration, so the seed row carries them.
    const message = await admin.from("coach_messages")
      .insert({ thread_id: threadId, user_id: a.id, role: "user", content: "hi", seq: 1 });
    expect(message.error).toBeNull();

    bClient = await userClient(b);
  });

  it.each(USER_TABLES)("user B reads zero rows from %s", async (table) => {
    const { data, error } = await bClient.from(table).select("*");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("user B cannot apply a sync op as user A", async () => {
    const { data, error } = await bClient.rpc("apply_sync_op", {
      p_user_id: a.id,
      p_op: { op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-09-11",
              kind: "update", base_rev: 1, payload: { cups: 99 },
              client_ts: new Date().toISOString() },
    });
    expect(data).toBeNull();
    expect(error?.message).toContain("forbidden");
    const check = await adminClient().from("water_log")
      .select("cups").eq("user_id", a.id).eq("local_date", "2026-09-11").single();
    expect(check.data?.cups).toBe(3);
  });

  // Phase 9 slice 1 (audit plan r3 finding 3): a stale tab still bound to A that calls the RPC
  // under B's session carries p_user = A, and the database refuses it rather than writing.
  it("user B cannot set a food membership as user A", async () => {
    const before = await adminClient().from("user_food_prefs").select("food_ref_id, status")
      .eq("user_id", a.id);
    const { data, error } = await bClient.rpc("set_food_membership", {
      p_user: a.id, p_name_norm: "chicken", p_status: "avoid", p_note: null, p_rev: Date.now(),
    });
    expect(data).toBeNull();
    expect(error?.message).toContain("forbidden");
    const after = await adminClient().from("user_food_prefs").select("food_ref_id, status")
      .eq("user_id", a.id);
    expect(after.data).toEqual(before.data);
  });

  it("user B cannot read user A's change feed", async () => {
    const { data, error } = await bClient.rpc("sync_changes", {
      p_user_id: a.id, p_since: 0, p_limit: 500,
    });
    expect(data).toBeNull();
    expect(error?.message).toContain("forbidden");
  });

  it("user B cannot register a food_ref for user A's food", async () => {
    const { data, error } = await bClient.rpc("get_or_create_food_ref", {
      p_user_id: a.id, p_kind: "user", p_catalog_food_id: null, p_user_food_id: foodId,
    });
    expect(data).toBeNull();
    expect(error?.message).toContain("forbidden");
  });

  // T11b: the body profile lives on user_settings, which the loop above already covers for reads.
  // The write half matters just as much — B must not be able to rewrite A's height, age, sex or
  // body-fat % and change the numbers her dashboard shows.
  it("user B can neither read nor update user A's body profile", async () => {
    const admin = adminClient();
    const seeded = await admin.from("user_settings")
      .update({ height_cm: 165, birth_year: 1996, sex: "female", body_fat_pct: 25 })
      .eq("user_id", a.id).select("height_cm");
    expect(seeded.error).toBeNull();
    expect(seeded.data).toHaveLength(1);

    const read = await bClient.from("user_settings")
      .select("height_cm, birth_year, sex, body_fat_pct").eq("user_id", a.id);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);

    const write = await bClient.from("user_settings")
      .update({ height_cm: 200, birth_year: 1900, sex: "male", body_fat_pct: 3 })
      .eq("user_id", a.id).select();
    expect(write.data).toEqual([]);
    const check = await admin.from("user_settings")
      .select("height_cm, birth_year, sex, body_fat_pct").eq("user_id", a.id).single();
    expect(check.data).toMatchObject({ height_cm: 165, birth_year: 1996, sex: "female",
      body_fat_pct: 25 });
  });

  it("user B cannot revoke user A's token", async () => {
    const { data, error } = await bClient.rpc("revoke_api_token", {
      p_user_id: a.id, p_token_id: tokenId,
    });
    expect(data).toBeNull();
    expect(error?.message).toContain("forbidden");
    const check = await adminClient().from("api_tokens")
      .select("revoked_at").eq("id", tokenId).single();
    expect(check.data?.revoked_at).toBeNull();
  });

  it("user B cannot look up a token hash at all", async () => {
    const { error } = await bClient.rpc("lookup_api_token", {
      p_token_hash: `\\x${Buffer.from("a".repeat(32)).toString("hex")}`,
    });
    expect(error).not.toBeNull();
  });

  it("user B cannot insert a row under user A's recipe, meal or thread", async () => {
    const revision = await bClient.from("recipe_revisions").insert({ recipe_id: recipeId, rev: 2 });
    expect(revision.error).not.toBeNull();

    const item = await bClient.from("recipe_items").insert({
      recipe_revision_id: recipeRevisionId, seq: 2, qty: 1, unit: "cup", food_ref_id: refId,
      grams: 10,
    });
    expect(item.error).not.toBeNull();

    const mealItem = await bClient.from("favorites_meal_items")
      .insert({ meal_id: mealId, seq: 2, food_ref_id: refId, grams: 10 });
    expect(mealItem.error).not.toBeNull();

    // Well-formed on purpose (user_id + seq present) so the denial below proves RLS, not a
    // NOT NULL violation.
    const message = await bClient.from("coach_messages")
      .insert({ thread_id: threadId, user_id: a.id, role: "user", content: "hack", seq: 2 });
    expect(message.error).not.toBeNull();

    const admin = adminClient();
    expect((await admin.from("recipe_revisions").select("id").eq("recipe_id", recipeId)).data)
      .toHaveLength(1);
    expect((await admin.from("recipe_items").select("seq")
      .eq("recipe_revision_id", recipeRevisionId)).data).toHaveLength(1);
    expect((await admin.from("favorites_meal_items").select("seq").eq("meal_id", mealId)).data)
      .toHaveLength(1);
    expect((await admin.from("coach_messages").select("id").eq("thread_id", threadId)).data)
      .toHaveLength(1);
  });

  it("user B cannot update a row under user A's recipe, meal or thread", async () => {
    const revision = await bClient.from("recipe_revisions").update({ rev: 99 })
      .eq("id", recipeRevisionId).select();
    expect(revision.data).toEqual([]);

    const item = await bClient.from("recipe_items").update({ grams: 999 })
      .eq("recipe_revision_id", recipeRevisionId).select();
    expect(item.data).toEqual([]);

    const mealItem = await bClient.from("favorites_meal_items").update({ grams: 999 })
      .eq("meal_id", mealId).select();
    expect(mealItem.data).toEqual([]);

    const message = await bClient.from("coach_messages").update({ content: "hacked" })
      .eq("thread_id", threadId).select();
    expect(message.data).toEqual([]);

    const admin = adminClient();
    expect((await admin.from("recipe_revisions").select("rev").eq("id", recipeRevisionId).single())
      .data?.rev).toBe(1);
    expect((await admin.from("recipe_items").select("grams")
      .eq("recipe_revision_id", recipeRevisionId).single()).data?.grams).toBe(100);
    expect((await admin.from("favorites_meal_items").select("grams").eq("meal_id", mealId).single())
      .data?.grams).toBe(100);
    expect((await admin.from("coach_messages").select("content").eq("thread_id", threadId).single())
      .data?.content).toBe("hi");
  });
});
