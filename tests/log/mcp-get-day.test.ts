/** Acceptance 12: MCP get_day returns the kcal, macros, fiber and coverage the phone shows.
 *  The privileged reader is exercised directly — the MCP transport is Lane B's. [needs branch] */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { dropCatalogFoods, seedCatalogFood, uuid } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/server/log.ts imports "server-only" — see tests/log/commit.test.ts for why only the
// marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { applyLogEntry } = await import("@/lib/server/log");

const run = HAS_BRANCH ? describe : describe.skip;
const DATE = "2026-09-22";

run("get_daily_totals through the privileged boundary", () => {
  let admin: SupabaseClient;
  let userId = "";

  beforeAll(async () => {
    const users = await createTestUsers();
    admin = users.admin;
    userId = users.a.userId;
    const chicken = await seedCatalogFood(admin, userId, { sourceId: "mcp-1",
      description: "Chicken thigh, roasted",
      per100g: { energy_kcal: 179, protein: 23.1, fiber_total: 0, iron: 1.1 } });
    await applyLogEntry(users.a.client, userId, { entry_id: uuid(601),
      eaten_at: `${DATE}T18:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
      method: "search", items: [{ id: uuid(611), seq: 1, food_ref_id: chicken.foodRefId,
        qty: 1, unit: "g", grams: 140 }] });
  });

  afterAll(async () => {
    await dropCatalogFoods(admin, "mcp-");
  });

  it("returns the same numbers the phone shows, bound by p_user_id", async () => {
    const { data, error } = await admin.rpc("get_daily_totals",
      { p_user_id: userId, p_local_date: DATE });
    expect(error).toBeNull();
    const rows = data as { nutrient_code: string; amount: number; coverage: number }[];
    expect(rows.find((r) => r.nutrient_code === "protein")?.amount).toBe(32.34);
    expect(rows.find((r) => r.nutrient_code === "energy_kcal")?.amount).toBe(250.6);
    expect(rows.find((r) => r.nutrient_code === "fiber_total")?.amount).toBe(0);
    expect(rows.find((r) => r.nutrient_code === "iron")?.coverage).toBe(1);
  });

  it("returns nothing for a date she did not log", async () => {
    const { data } = await admin.rpc("get_daily_totals",
      { p_user_id: userId, p_local_date: "2001-01-01" });
    expect(data).toEqual([]);
  });
});
