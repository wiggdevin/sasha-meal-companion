/**
 * Phase 2 acceptance 8 and the 4xx half of the spec's error table, at the HTTP layer.
 * [needs branch] — skipped when SUPABASE_TEST_URL is unset.
 */
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { TEST_PROFILE } from "../helpers/constraint-profile";
import { dropCatalogFoods, pointRequestClientAtBranch, seedCatalogFood, sessionCookieFor, uuid,
  type Fixture } from "./fixtures";

// lib/server/log.ts imports "server-only", which throws outside a server component (see
// tests/mcp/scope.test.ts). The route under test reaches it for real — this is what the branch
// exercises — so only the marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { POST } = await import("../../app/api/log/commit/route");

const run = HAS_BRANCH ? describe : describe.skip;

function post(body: unknown, cookie?: string): Request {
  return new Request("https://app.test/api/log/commit", { method: "POST",
    headers: { "content-type": "application/json",
      ...(cookie ? { cookie, ...accountHeaderFromCookie(cookie) } : {}) },
    body: JSON.stringify(body) });
}

run("POST /api/log/commit", () => {
  let cookie = "";
  let chicken: Fixture;
  let bread: Fixture;
  let cheese: Fixture;
  let apple: Fixture;
  let admin: SupabaseClient;

  beforeAll(async () => {
    pointRequestClientAtBranch();
    const users = await createTestUsers();
    const a = users.a;
    admin = users.admin;
    // D1 §6.1 / 20261026090100: the policy reads only this account's own row, and a row-less
    // account restricts nothing — so the three "records an X item and marks it" cases below need
    // the account's rules seeded. TEST_PROFILE is the fixture that replaced the deleted
    // in-code DEFAULT_PROFILE (gluten/dairy/apple + five banned categories).
    const rules = await admin.from("constraint_profiles").upsert({
      user_id: a.userId, rev: 1, conditions: [], notes: null, ...TEST_PROFILE,
    }, { onConflict: "user_id" });
    expect(rules.error).toBeNull();
    chicken = await seedCatalogFood(admin, a.userId, { sourceId: "commit-1",
      description: "Chicken thigh, roasted",
      per100g: { energy_kcal: 179, protein: 23.1, fat_total: 9.3, carbohydrate: 0,
        fiber_total: 0, iron: null } });
    // contracts §9a(d): gluten, dairy and apple each carry their own allergen tag on the one
    // catalog_ingredients row applyLogEntry's constraint policy reads at commit time.
    bread = await seedCatalogFood(admin, a.userId, { sourceId: "commit-bread",
      description: "White bread", per100g: { energy_kcal: 265, protein: 9, fat_total: 3.2,
        carbohydrate: 49, fiber_total: 2.7 }, allergenTags: ["gluten"] });
    cheese = await seedCatalogFood(admin, a.userId, { sourceId: "commit-cheese",
      description: "Cheddar cheese", per100g: { energy_kcal: 403, protein: 25, fat_total: 33,
        carbohydrate: 1.3, fiber_total: 0 }, allergenTags: ["dairy"] });
    apple = await seedCatalogFood(admin, a.userId, { sourceId: "commit-apple",
      description: "Apple, raw", per100g: { energy_kcal: 52, protein: 0.3, fat_total: 0.2,
        carbohydrate: 14, fiber_total: 2.4 }, allergenTags: ["apple"] });
    cookie = await sessionCookieFor(a.client);
  });

  afterAll(async () => {
    await dropCatalogFoods(admin, "commit-");
  });

  beforeEach(() => {
    resetRateLimits();
  });

  // log_items.id is a global primary key (supabase/migrations/20260911000200_user_schema.sql),
  // not scoped per entry_id, and _sync_upsert inserts it with no ON CONFLICT — so two different
  // entries created in the same run must never default to the same item id. A counter, not the
  // brief's fixed uuid(21), keeps every default item id distinct across the whole suite.
  let nextItemId = 200;
  function body(over: Record<string, unknown> = {}, entry = uuid(11)) {
    return { entry_id: entry, eaten_at: "2026-09-18T02:30:00.000Z",
      tz: "America/Los_Angeles", local_date: "2026-09-17", slot: "meal-3", method: "search",
      items: [{ id: uuid(nextItemId++), seq: 1, food_ref_id: chicken.foodRefId, qty: 1, unit: "g",
        grams: 140 }], ...over };
  }

  it("401s with no session", async () => {
    expect((await POST(post(body()))).status).toBe(401);
  });

  it("creates the entry, stores the server snapshot and returns the day's totals", async () => {
    const res = await POST(post(body({}, uuid(101)), cookie));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ status: "ok", entry_id: uuid(101), rev: 1 });
    expect(out.items[0].snapshot.protein.amount).toBe(32.34);
    expect(out.items[0].snapshot.iron.amount).toBeNull();
    expect(out.totals.local_date).toBe("2026-09-17");
    expect(out.totals.nutrients.find((n: { code: string }) => n.code === "protein"))
      .toMatchObject({ amount: 32.34, itemsWithValue: 1, itemsTotal: 1, coverage: 1 });
    expect(out.totals.micro_coverage_pct).toBe(8);
  });

  it("persists, preserves, and explicitly clears the dish title", async () => {
    const entry = uuid(113);
    const res = await POST(post(body({ title: "Spaghetti bolognese" }, entry), cookie));
    expect(res.status).toBe(200);
    const created = await admin.from("log_entries").select("title").eq("id", entry).single();
    expect(created.error).toBeNull();
    expect(created.data?.title).toBe("Spaghetti bolognese");

    const kept = await POST(post(body({ base_rev: 1, note: "Still good" }, entry), cookie));
    expect(kept.status).toBe(200);
    await expect(admin.from("log_entries").select("title").eq("id", entry).single())
      .resolves.toMatchObject({ data: { title: "Spaghetti bolognese" }, error: null });

    const cleared = await POST(post(body({ base_rev: 2, title: null }, entry), cookie));
    expect(cleared.status).toBe(200);
    await expect(admin.from("log_entries").select("title").eq("id", entry).single())
      .resolves.toMatchObject({ data: { title: null }, error: null });
  });

  it("returns the first result on a replay and creates no second entry", async () => {
    const first = await (await POST(post(body({}, uuid(102)), cookie))).json();
    const second = await (await POST(post(body({}, uuid(102)), cookie))).json();
    expect(second).toMatchObject({ status: "ok", rev: first.rev, entry_id: uuid(102) });
    expect(second.items).toHaveLength(1);
    expect(second.totals.nutrients.find((n: { code: string }) => n.code === "protein").amount)
      .toBe(first.totals.nutrients.find((n: { code: string }) => n.code === "protein").amount);
  });

  it("409s a stale base_rev with the full current entity and writes nothing", async () => {
    await POST(post(body({}, uuid(103)), cookie));
    const res = await POST(post(body({ base_rev: 7, note: "should not land" }, uuid(103)), cookie));
    expect(res.status).toBe(409);
    const out = await res.json();
    expect(out.status).toBe("conflict");
    expect(out.current_rev).toBe(1);
    expect(out.entity.id).toBe(uuid(103));
    expect(out.entity.note).toBeNull();
    expect(out.entity.items).toHaveLength(1);
  });

  it("410s an update to an entry that was never created", async () => {
    const res = await POST(post(body({ base_rev: 1 }, uuid(104)), cookie));
    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ status: "gone" });
  });

  it("409s an item pinned to a revision that is no longer active", async () => {
    const res = await POST(post(body({ items: [{ id: uuid(22), seq: 1,
      food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: 140,
      food_revision_id: 999_999 }] }, uuid(105)), cookie));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ status: "stale_revision",
      food_ref_id: chicken.foodRefId, revision_id: 999_999 });
  });

  it("422s negative grams, a duplicate seq and a local_date that disagrees with tz", async () => {
    const negative = await POST(post(body({ items: [{ id: uuid(23), seq: 1,
      food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: -5 }] }, uuid(106)), cookie));
    expect(negative.status).toBe(422);
    expect((await negative.json()).issues[0].path).toBe("items.0.grams");

    const wrongDay = await POST(post(body({ local_date: "2026-09-18" }, uuid(107)), cookie));
    expect(wrongDay.status).toBe(422);
    expect((await wrongDay.json()).issues).toContainEqual({ path: "local_date",
      message: "local_date does not match eaten_at in tz" });

    const longTitle = await POST(post(body({ title: "x".repeat(81) }, uuid(114)), cookie));
    expect(longTitle.status).toBe(422);
    expect((await longTitle.json()).issues).toContainEqual({ path: "title",
      message: "must be 80 characters or fewer" });
  });

  it("422s an unknown food_ref_id", async () => {
    const res = await POST(post(body({ items: [{ id: uuid(24), seq: 1, food_ref_id: uuid(999),
      qty: 1, unit: "g", grams: 100 }] }, uuid(108)), cookie));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ status: "invalid",
      issues: [{ path: "items.0.food_ref_id", message: "unknown food_ref_id" }] });
  });

  it("413s a body over 64 KB", async () => {
    const res = await POST(post(body({ note: "x".repeat(70_000) }, uuid(109)), cookie));
    expect(res.status).toBe(413);
  });

  // contracts §9a(d) plus the 2026-09-14 ruling: the policy still re-runs server-side on every
  // commit, but its verdict now MARKS the entry instead of refusing it
  // (docs/decisions/2026-09-14-logging-marks-never-refuses.md). The account seeded above carries
  // those allergen rules, and the diary exists to connect what was eaten to how the person felt —
  // an accidental gluten that cannot be written down leaves the flare it would have explained with
  // no cause in the data. Each case therefore writes the row AND comes back flagged.
  it("records a gluten item and marks it", async () => {
    const entry = uuid(110);
    const res = await POST(post(body({ items: [{ id: uuid(30), seq: 1,
      food_ref_id: bread.foodRefId, qty: 1, unit: "g", grams: 50 }] }, entry), cookie));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok",
      flagged: [{ path: "items.0", message: "blocked:allergen:gluten" }] });
    const row = await admin.from("log_entries").select("id").eq("id", entry).maybeSingle();
    expect(row.data?.id).toBe(entry);
  });

  it("records a dairy item and marks it", async () => {
    const entry = uuid(111);
    const res = await POST(post(body({ items: [{ id: uuid(31), seq: 1,
      food_ref_id: cheese.foodRefId, qty: 1, unit: "g", grams: 30 }] }, entry), cookie));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok",
      flagged: [{ path: "items.0", message: "blocked:allergen:dairy" }] });
    const row = await admin.from("log_entries").select("id").eq("id", entry).maybeSingle();
    expect(row.data?.id).toBe(entry);
  });

  it("records an apple item and marks it", async () => {
    const entry = uuid(112);
    const res = await POST(post(body({ items: [{ id: uuid(32), seq: 1,
      food_ref_id: apple.foodRefId, qty: 1, unit: "g", grams: 100 }] }, entry), cookie));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok",
      flagged: [{ path: "items.0", message: "blocked:allergen:apple" }] });
    const row = await admin.from("log_entries").select("id").eq("id", entry).maybeSingle();
    expect(row.data?.id).toBe(entry);
  });
});
