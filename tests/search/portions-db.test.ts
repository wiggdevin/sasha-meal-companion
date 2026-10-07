/**
 * Serving data (lib/foods/portions.ts) over the real `/api/foods/search` route path: a seeded
 * catalog food with a real portion and energy comes back with the right `defaultPortion` and
 * `kcal`, read through the same `searchFoods` the route calls — not a mock.
 *
 * [needs branch] — skips without SUPABASE_TEST_URL (HAS_BRANCH).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchFoods } from "@/lib/server/catalog";
import { dropCatalogFoods, seedCatalogFood } from "../log/fixtures";
import { adminClient, ensureUser, HAS_BRANCH, userClient } from "../helpers/supabase";

if (!HAS_BRANCH) {
  console.warn(
    "[needs branch] tests/search/portions-db.test.ts: the real search-route portion/kcal read is "
    + "NOT pinned in this run — set SUPABASE_TEST_URL to check it.");
}

describe.skipIf(!HAS_BRANCH)("search carries real portions and kcal through [needs branch]", () => {
  let client: SupabaseClient;
  let admin: SupabaseClient;
  const sourceId = "portions-db-1";

  beforeAll(async () => {
    const user = await ensureUser("a");
    client = await userClient(user);
    admin = adminClient();
    await seedCatalogFood(admin, user.id, {
      sourceId,
      description: "Zzqportions probe chicken breast",
      per100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6 },
      portions: [
        { description: "3 oz", gram_weight: 85, is_default: true, seq: 1 },
        { description: "1 breast", gram_weight: 172, is_default: false, seq: 2 },
      ],
    });
  });

  afterAll(async () => {
    await dropCatalogFoods(admin, sourceId);
  });

  it("returns the seeded food's defaultPortion and kcal from a real search", async () => {
    const res = await searchFoods(client, { q: "Zzqportions probe chicken" });
    const hit = res.hits.find((h) => h.description === "Zzqportions probe chicken breast");
    expect(hit).toBeDefined();
    expect(hit!.kcalPer100g).toBe(165);
    expect(hit!.per100g).toEqual({ kcal: 165, protein: 31, carbs: 0, fat: 3.6 });
    expect(hit!.defaultPortion).toEqual({ id: expect.any(String), label: "3 oz", grams: 85, kcal: 140 });
    expect(hit!.portions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "1 breast", grams: 172, kcal: 284 }),
      { id: null, label: "100 g", grams: 100, kcal: 165 },
    ]));
  });
});
