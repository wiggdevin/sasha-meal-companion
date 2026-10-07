/**
 * T9 §4 — the shape PostgREST returns for `user_foods → food_refs`.
 *
 * `lib/server/catalog.ts` reads a mapped food's ref through an embedded resource. PostgREST
 * returns an ARRAY for a to-many embed and an OBJECT for one it can prove is to-one, and
 * `food_refs.user_food_id` carries a UNIQUE index — a partial one, `where user_food_id is not
 * null` (20260911000200), which is why the answer today is still an array. If a PostgREST upgrade
 * ever starts reading that index as one-to-one, every search and detail of a mapped food would
 * iterate an object: this test is what makes that loud instead of a 500 in production.
 *
 * [needs branch] — the live half skips without SUPABASE_TEST_URL. The normaliser below is checked
 * either way, so the file is never silent.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, ensureUser, HAS_BRANCH } from "../helpers/supabase";
import { seedCatalogFood, dropCatalogFoods } from "../log/fixtures";
import { refsOfEmbed } from "@/lib/server/catalog";

if (!HAS_BRANCH) {
  console.warn(
    "[needs branch] tests/search/policy-refs-embed.test.ts: the live embed shape is NOT pinned in "
    + "this run — set SUPABASE_TEST_URL to check it.");
}

describe("refsOfEmbed", () => {
  it("reads an array embed, an object embed and an absent one alike", () => {
    expect(refsOfEmbed([{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
    expect(refsOfEmbed({ id: "a" })).toEqual(["a"]);
    expect(refsOfEmbed(null)).toEqual([]);
    expect(refsOfEmbed(undefined)).toEqual([]);
  });
});

const run = HAS_BRANCH ? describe : describe.skip;

run("the live user_foods → food_refs embed [needs branch]", () => {
  const userFoodId = "aaaaaaaa-0000-4000-8000-0000000009e1";
  const refId = "bbbbbbbb-0000-4000-8000-0000000009e1";
  let admin: SupabaseClient;
  let catalogFoodId = 0;

  beforeAll(async () => {
    admin = adminClient();
    const user = await ensureUser("a");
    await cleanup();
    const fixture = await seedCatalogFood(admin, user.id, { sourceId: "t9-embed-1",
      description: "Embed probe food", per100g: { energy_kcal: 100, protein: 1 } });
    catalogFoodId = fixture.foodId;
    const food = await admin.from("user_foods").insert({ id: userFoodId, user_id: user.id,
      name: "T9 embed probe", kind: "custom", catalog_food_id: catalogFoodId, per_100g: {} });
    if (food.error) throw food.error;
    const ref = await admin.from("food_refs")
      .insert({ id: refId, kind: "user", user_food_id: userFoodId });
    if (ref.error) throw ref.error;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await admin.from("food_refs").delete().eq("id", refId);
    await admin.from("user_foods").delete().eq("id", userFoodId);
    await dropCatalogFoods(admin, "t9-embed-");
  }

  it("comes back as an array of rows, which is the shape the mocks use", async () => {
    const { data, error } = await admin.from("user_foods")
      .select("catalog_food_id, food_refs ( id )").eq("catalog_food_id", catalogFoodId);
    expect(error).toBeNull();
    const rows = (data ?? []) as { catalog_food_id: number; food_refs: unknown }[];
    expect(rows).toHaveLength(1);
    expect(Array.isArray(rows[0].food_refs)).toBe(true);
    expect(refsOfEmbed(rows[0].food_refs)).toEqual([refId]);
  });
});
