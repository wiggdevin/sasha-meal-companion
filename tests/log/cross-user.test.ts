/** Acceptance 11: a second user reading the view, the privileged RPC, the route or a log_items
 *  row whose parent belongs to user A gets zero rows or a 4xx. [needs branch]
 *
 * Ruling R3: the route reads identity from the session cookie, never a Bearer header, so user
 * B's POST authenticates with `cookie: await sessionCookieFor(b.client)` after
 * `pointRequestClientAtBranch()` — same pattern as tests/log/commit.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyLogEntry } from "@/lib/server/log";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { dropCatalogFoods, pointRequestClientAtBranch, seedCatalogFood, sessionCookieFor, uuid,
  type Fixture } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";

// lib/server/log.ts imports "server-only" — see tests/log/commit.test.ts for why only the
// marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { POST } = await import("../../app/api/log/commit/route");

const run = HAS_BRANCH ? describe : describe.skip;
const DATE = "2026-09-20";

run("cross-user denial on the Phase 2 surfaces", () => {
  let bClient: SupabaseClient;
  let bCookie = "";
  let aUserId = "";
  let chicken: Fixture;
  let admin: SupabaseClient;

  beforeAll(async () => {
    pointRequestClientAtBranch();
    const users = await createTestUsers();
    const { a, b } = users;
    admin = users.admin;
    aUserId = a.userId;
    bClient = b.client;
    chicken = await seedCatalogFood(admin, a.userId, { sourceId: "xuser-1",
      description: "Chicken thigh, roasted", per100g: { protein: 23.1, energy_kcal: 179 } });
    await applyLogEntry(a.client, a.userId, { entry_id: uuid(401),
      eaten_at: `${DATE}T19:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
      method: "search", items: [{ id: uuid(411), seq: 1, food_ref_id: chicken.foodRefId,
        qty: 1, unit: "g", grams: 140 }] });
    bCookie = await sessionCookieFor(b.client);
  });

  afterAll(async () => {
    await dropCatalogFoods(admin, "xuser-");
  });

  it("gives user B zero rows from daily_totals", async () => {
    const { data, error } = await bClient.from("daily_totals").select("*").eq("local_date", DATE);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("refuses user B the privileged get_daily_totals", async () => {
    const { error } = await bClient.rpc("get_daily_totals",
      { p_user_id: aUserId, p_local_date: DATE });
    expect(error).not.toBeNull();
  });

  it("gives user B zero log_items for user A's entry", async () => {
    const { data } = await bClient.from("log_items").select("id").eq("entry_id", uuid(401));
    expect(data).toEqual([]);
  });

  it("does not let user B write against user A's entry_id", async () => {
    const res = await POST(new Request("https://app.test/api/log/commit", { method: "POST",
      headers: { "content-type": "application/json", cookie: bCookie,
        ...accountHeaderFromCookie(bCookie) },
      body: JSON.stringify({ entry_id: uuid(401), base_rev: 1,
        eaten_at: `${DATE}T19:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
        method: "search", items: [{ id: uuid(411), seq: 1, food_ref_id: chicken.foodRefId,
          qty: 1, unit: "g", grams: 999 }] }) }));
    expect(res.status).toBe(410);
    const stillHers = await bClient.from("log_items").select("grams").eq("entry_id", uuid(401));
    expect(stillHers.data).toEqual([]);
  });
});
