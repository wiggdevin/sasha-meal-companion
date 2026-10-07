import { describe, expect, it } from "vitest";
import { HAS_BRANCH, createTestUsers } from "../helpers/supabase";
import { uuid } from "../log/fixtures";

const RECIPE = uuid(32);

/** AC 11: every Phase 3 table refuses a read and a write from a second authenticated user. */
describe.skipIf(!HAS_BRANCH)("phase 3 cross-user denial", () => {
  const OWNED = ["recipes", "recipe_revisions", "recipe_items", "favorites_foods",
    "favorites_recipes", "favorites_meals", "favorites_meal_items", "user_settings"];

  it("shows user b none of user a's rows", async () => {
    const { a, b, admin } = await createTestUsers();
    await admin.from("recipes").upsert({ id: RECIPE, user_id: a.userId, name: "Hers", servings: 4 });
    for (const table of OWNED) {
      const { data, error } = await b.client.from(table).select("*");
      expect([table, error]).toEqual([table, null]);   // RLS filters, it does not error
      expect([table, data?.length ?? 0]).toEqual([table, 0]);
    }
  });

  it("refuses user b's write into user a's recipe", async () => {
    const { a, b } = await createTestUsers();
    const { error } = await b.client.from("recipes")
      .update({ name: "Mine now" }).eq("user_id", a.userId);
    expect(error === null).toBe(true);
    const still = await b.client.from("recipes").select("id").eq("user_id", a.userId);
    expect(still.data?.length ?? 0).toBe(0);
  });

  it("refuses an apply_sync_op aimed at another user", async () => {
    const { a, b } = await createTestUsers();
    const { error } = await b.client.rpc("apply_sync_op", { p_user_id: a.userId,
      p_op: { op_id: crypto.randomUUID(), entity: "recipes", entity_id: RECIPE, kind: "update",
              base_rev: 1, payload: {}, client_ts: new Date().toISOString() } });
    expect(error?.message).toContain("forbidden");
  });
});
