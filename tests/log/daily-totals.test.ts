/** Acceptance 3 and 4: a grams edit moves the day by exactly the difference, and an unmeasured
 *  value lowers coverage without lowering the total. [needs branch] */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { dropCatalogFoods, seedCatalogFood, uuid, type Fixture } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/server/log.ts imports "server-only" — see tests/log/commit.test.ts for why only the
// marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { applyLogEntry } = await import("@/lib/server/log");
const { dayTotals } = await import("@/lib/server/day-totals");

const run = HAS_BRANCH ? describe : describe.skip;
const DATE = "2026-09-19";

run("daily_totals", () => {
  let client: SupabaseClient;
  let userId = "";
  let chicken: Fixture;
  let spice: Fixture;
  let admin: SupabaseClient;

  beforeAll(async () => {
    const users = await createTestUsers();
    const a = users.a;
    admin = users.admin;
    client = a.client;
    userId = a.userId;
    chicken = await seedCatalogFood(admin, userId, { sourceId: "totals-1",
      description: "Chicken thigh, roasted",
      per100g: { energy_kcal: 179, protein: 23.1, iron: 1.1, fiber_total: 0 } });
    spice = await seedCatalogFood(admin, userId, { sourceId: "totals-2",
      description: "Cumin, ground", per100g: { energy_kcal: 375, protein: 17.8, iron: null } });
  });

  afterAll(async () => {
    await dropCatalogFoods(admin, "totals-");
  });

  function entry(entryId: string, items: Record<string, unknown>[], baseRev?: number) {
    return { entry_id: entryId, base_rev: baseRev, eaten_at: `${DATE}T19:00:00.000Z`,
      tz: "UTC", local_date: DATE, slot: "meal-2", method: "search", items };
  }

  it("sums the day, and an unmeasured iron lowers coverage but not the total", async () => {
    await applyLogEntry(client, userId, entry(uuid(201), [{ id: uuid(211), seq: 1,
      food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: 100 }]));
    await applyLogEntry(client, userId, entry(uuid(202), [{ id: uuid(212), seq: 1,
      food_ref_id: spice.foodRefId, qty: 1, unit: "g", grams: 5 }]));

    const totals = await dayTotals(client, userId, DATE);
    const iron = totals.nutrients.find((n) => n.code === "iron")!;
    expect(iron).toMatchObject({ amount: 1.1, itemsWithValue: 1, itemsTotal: 2, coverage: 0.5 });
    const protein = totals.nutrients.find((n) => n.code === "protein")!;
    expect(protein.amount).toBe(23.99);
    expect(totals.nutrients.find((n) => n.code === "fiber_total"))
      .toMatchObject({ amount: 0, itemsWithValue: 1, coverage: 0.5 });
  });

  it("moves the day by exactly the difference when grams are edited", async () => {
    const before = await dayTotals(client, userId, DATE);
    const beforeProtein = before.nutrients.find((n) => n.code === "protein")!.amount;

    const edited = await applyLogEntry(client, userId, entry(uuid(201), [{ id: uuid(211), seq: 1,
      food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: 200, was_edited: true }], 1));
    expect(edited.status).toBe("ok");

    const after = await dayTotals(client, userId, DATE);
    const afterProtein = after.nutrients.find((n) => n.code === "protein")!.amount;
    expect(Math.round((afterProtein - beforeProtein) * 100) / 100).toBe(23.1);
  });

  it("leaves an untouched item's snapshot frozen when only the note changes", async () => {
    const before = await dayTotals(client, userId, DATE);
    const noteOnly = await applyLogEntry(client, userId, {
      ...entry(uuid(202), [{ id: uuid(212), seq: 1, food_ref_id: spice.foodRefId, qty: 1,
        unit: "g", grams: 5 }], 1), note: "a pinch" });
    expect(noteOnly.status).toBe("ok");
    const after = await dayTotals(client, userId, DATE);
    expect(after.nutrients.find((n) => n.code === "protein")!.amount)
      .toBe(before.nutrients.find((n) => n.code === "protein")!.amount);
  });

  it("drops a tombstoned entry out of the day", async () => {
    const { error } = await client.rpc("apply_sync_op", { p_user_id: userId, p_op: {
      op_id: uuid(301), entity: "log_entries", entity_id: uuid(202), kind: "delete",
      base_rev: 2, payload: {}, client_ts: new Date().toISOString() } });
    expect(error).toBeNull();
    const after = await dayTotals(client, userId, DATE);
    expect(after.nutrients.find((n) => n.code === "iron")!.itemsTotal).toBe(1);
  });
});
