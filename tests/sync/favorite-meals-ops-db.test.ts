/**
 * The meal card's heart (lib/favorite-meals-client.ts) needs no migration: the existing
 * `apply_sync_op` "favorites_meals" create writes the row AND its items in one call, owner-scoped,
 * and its delete tombstones by id. This proves that against the local stack; it creates its own
 * rows under the shared test users and removes them, and never resets a user or the stack.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HAS_BRANCH, adminClient, ensureUser, userClient, type TestUser } from "../helpers/supabase";
import { seedUserFood } from "../log/fixtures";

type Result = Record<string, unknown> & { status: string };

const created: string[] = [];

async function op(
  client: SupabaseClient, userId: string, entityId: string, kind: "create" | "delete",
  baseRev: number | null, payload: Record<string, unknown> = {},
): Promise<{ data: Result | null; error: { message: string } | null }> {
  const { data, error } = await client.rpc("apply_sync_op", {
    p_user_id: userId,
    p_op: { op_id: crypto.randomUUID(), entity: "favorites_meals", entity_id: entityId, kind,
      base_rev: baseRev, payload, client_ts: new Date().toISOString() },
  });
  return { data: data as Result | null, error };
}

async function setup(): Promise<{ a: TestUser; b: TestUser; aClient: SupabaseClient; bClient: SupabaseClient }> {
  const [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
  return { a, b, aClient: await userClient(a), bClient: await userClient(b) };
}

afterAll(async () => {
  if (!HAS_BRANCH || created.length === 0) return;
  await adminClient().from("favorites_meals").delete().in("id", created);
});

describe.skipIf(!HAS_BRANCH)("favorites_meals over apply_sync_op (the heart's server path)", () => {
  it("creates the saved meal and its items in one op, and tombstones it by id", async () => {
    const { a, aClient } = await setup();
    const admin = adminClient();
    const rice = await seedUserFood(admin, a.id, { name: `fav rice ${crypto.randomUUID()}`,
      per100g: { energy_kcal: 130, protein: 2.7, carbohydrate: 28, fat_total: 0.3 } });
    const egg = await seedUserFood(admin, a.id, { name: `fav egg ${crypto.randomUUID()}`,
      per100g: { energy_kcal: 143, protein: 12.6, carbohydrate: 0.7, fat_total: 9.5 } });
    const id = crypto.randomUUID();
    created.push(id);
    const items = [{ seq: 1, food_ref_id: rice.foodRefId, grams: 150 },
      { seq: 2, food_ref_id: egg.foodRefId, grams: 100 }];
    const applied = await op(aClient, a.id, id, "create", null, { id, name: "Rice and egg", sort: 1, items });
    expect(applied.error).toBeNull();
    expect(applied.data).toMatchObject({ status: "applied", rev: 1 });

    const row = await admin.from("favorites_meals").select("user_id, name, sort, deleted_at").eq("id", id).single();
    expect(row.data).toEqual({ user_id: a.id, name: "Rice and egg", sort: 1, deleted_at: null });
    const stored = await admin.from("favorites_meal_items").select("seq, food_ref_id, grams")
      .eq("meal_id", id).order("seq");
    expect(stored.data?.map((i) => ({ ...i, grams: Number(i.grams) }))).toEqual(items);

    const removed = await op(aClient, a.id, id, "delete", 1);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ status: "applied" });
    const after = await admin.from("favorites_meals").select("deleted_at").eq("id", id).single();
    expect(after.data?.deleted_at).not.toBeNull();
  });

  it("refuses another account's food ref and writes no row (owner-scoped)", async () => {
    const { a, b, bClient } = await setup();
    const admin = adminClient();
    const theirs = await seedUserFood(admin, a.id, { name: `fav theirs ${crypto.randomUUID()}`,
      per100g: { energy_kcal: 100, protein: 1, carbohydrate: 1, fat_total: 1 } });
    const id = crypto.randomUUID();
    created.push(id);
    const attempt = await op(bClient, b.id, id, "create", null,
      { id, name: "Stolen", sort: 1, items: [{ seq: 1, food_ref_id: theirs.foodRefId, grams: 50 }] });
    expect(attempt.error !== null || attempt.data?.status !== "applied").toBe(true);
    expect((await admin.from("favorites_meals").select("id").eq("id", id)).data).toEqual([]);
    expect((await admin.from("favorites_meal_items").select("seq").eq("meal_id", id)).data).toEqual([]);
  });

  it("refuses to write under another account's user id", async () => {
    const { a, bClient } = await setup();
    const id = crypto.randomUUID();
    created.push(id);
    const attempt = await op(bClient, a.id, id, "create", null, { id, name: "Not mine", sort: 1, items: [] });
    expect(attempt.error !== null || attempt.data?.status !== "applied").toBe(true);
    expect((await adminClient().from("favorites_meals").select("id").eq("id", id)).data).toEqual([]);
  });
});
