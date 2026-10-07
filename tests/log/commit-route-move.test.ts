/**
 * T9 §2 guard — `lib/server/log.ts` is split into smaller files, never rewritten.
 *
 * The commit route is the whole of that file's public behaviour, so this pins the route's own
 * answer for the two shapes §2 touches: a normal catalog entry, and a label-food entry whose
 * placeholder ref the server swaps for a freshly minted one.
 *
 * `totals` covers the whole of one user-day, so the day this suite writes to has to be its own:
 * each test has a date of its own, the label food's name is unique to this file, and both
 * cleanups plus an entry count per test make pollution fail loudly instead of quietly rewriting
 * the snapshot. The 2026-09-19 this started on is also tests/log/daily-totals.test.ts's date, and
 * the two files running in parallel broke each other.
 *
 * [needs branch] — skipped when SUPABASE_TEST_URL is unset, like every other suite in tests/.
 */
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { NUTRIENT_CODES } from "@/lib/nutrients/codes";
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/server/log-label-food";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { dropCatalogFoods, pointRequestClientAtBranch, seedCatalogFood, sessionCookieFor,
  type Fixture } from "./fixtures";

vi.mock("server-only", () => ({}));

const { POST } = await import("../../app/api/log/commit/route");

const run = HAS_BRANCH ? describe : describe.skip;

/**
 * One day per test, because `totals` covers a whole user-day: sharing one made the label case's
 * totals include the pork entry, so it was only green after the normal case had run. Nothing else
 * in tests/ or lib/ writes to either date — grep before changing them.
 */
const NORMAL_DATE = "2026-10-21";
const LABEL_DATE = "2026-10-22";
const LABEL_NAME = "T9 commit-route-move guard pouch";

const LABEL_PER_100G = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, null])) as
  Record<string, number | null>;
LABEL_PER_100G.energy_kcal = 60;
LABEL_PER_100G.protein = 0.4;

function post(body: unknown, cookie: string): Request {
  return new Request("https://app.test/api/log/commit", { method: "POST",
    headers: { "content-type": "application/json", cookie, ...accountHeaderFromCookie(cookie) },
    body: JSON.stringify(body) });
}

/**
 * Ids are minted per run so a replay never meets a tombstone, and the fixture's revision is a
 * serial. Both are masked; every amount, unit, source and coverage number is asserted as-is.
 */
function stable(out: Record<string, unknown>): Record<string, unknown> {
  const items = (out.items as { id: string; snapshot: Record<string, { revision_id?: number }> }[])
    .map((i) => ({
      ...i, id: "<item>",
      // T0 made the reply carry the complete item row (the client mirror needs it whole); the
      // row's own ids are minted per run and are masked like `id` is.
      ...("entry_id" in i ? { entry_id: "<entry>" } : {}),
      ...("food_ref_id" in i ? { food_ref_id: "<ref>" } : {}),
      snapshot: Object.fromEntries(Object.entries(i.snapshot).map(([code, value]) =>
        [code, "revision_id" in value ? { ...value, revision_id: "<revision>" } : value])),
    }));
  return { ...out, entry_id: "<entry>", items,
    ...("user_food_id" in out ? { user_food_id: "<minted>" } : {}) };
}

run("POST /api/log/commit — the shapes T9 §2 must not change", () => {
  let cookie = "";
  let pork: Fixture;
  let admin: SupabaseClient;
  let userId = "";
  const id = () => crypto.randomUUID();

  beforeAll(async () => {
    pointRequestClientAtBranch();
    const users = await createTestUsers();
    admin = users.admin;
    userId = users.a.userId;
    await clearItems();
    await clearEntries();
    pork = await seedCatalogFood(admin, users.a.userId, { sourceId: "t9-move-1",
      description: "Pork loin, roasted",
      per100g: { energy_kcal: 201, protein: 27.3, fat_total: 9.4, carbohydrate: 0,
        fiber_total: 0, iron: 0.9 } });
    cookie = await sessionCookieFor(users.a.client);
  });

  afterAll(async () => {
    await clearItems();
    await clearEntries();
  });

  /** This suite's own days, emptied. Entry ids are minted per run, so a tombstone is never met. */
  async function clearEntries(): Promise<void> {
    const { error } = await admin.from("log_entries").delete()
      .eq("user_id", userId).in("local_date", [NORMAL_DATE, LABEL_DATE]);
    if (error) throw error;
  }

  /** What the day holds right now. The snapshot below is only meaningful while this is ours. */
  async function entryCount(date: string): Promise<number> {
    const { count, error } = await admin.from("log_entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("local_date", date);
    if (error) throw error;
    return count ?? 0;
  }

  /** Children first, the way dropCatalogFoods does it: every FK below is NO ACTION. */
  async function clearItems(): Promise<void> {
    await dropCatalogFoods(admin, "t9-move-");
    const foods = await admin.from("user_foods").select("id").eq("name", LABEL_NAME);
    if (foods.error) throw foods.error;
    const foodIds = (foods.data ?? []).map((f) => (f as { id: string }).id);
    if (foodIds.length === 0) return;
    const refs = await admin.from("food_refs").select("id").in("user_food_id", foodIds);
    if (refs.error) throw refs.error;
    const refIds = (refs.data ?? []).map((r) => (r as { id: string }).id);
    if (refIds.length > 0) {
      const items = await admin.from("log_items").delete().in("food_ref_id", refIds);
      if (items.error) throw items.error;
      const dropped = await admin.from("food_refs").delete().in("id", refIds);
      if (dropped.error) throw dropped.error;
    }
    const { error } = await admin.from("user_foods").delete().in("id", foodIds);
    if (error) throw error;
  }

  beforeEach(() => {
    resetRateLimits();
  });

  it("commits a normal entry", async () => {
    const res = await POST(post({ entry_id: id(), eaten_at: `${NORMAL_DATE}T18:00:00.000Z`,
      tz: "UTC", local_date: NORMAL_DATE, slot: "meal-2", method: "search",
      items: [{ id: id(), seq: 0, food_ref_id: pork.foodRefId, qty: 1, unit: "g",
        grams: 120 }] }, cookie));
    expect(res.status).toBe(200);
    expect(await entryCount(NORMAL_DATE)).toBe(1);
    expect(stable(await res.json())).toMatchSnapshot();
  });

  it("commits a label-food entry and swaps the placeholder ref", async () => {
    const res = await POST(post({ entry_id: id(), eaten_at: `${LABEL_DATE}T20:00:00.000Z`,
      tz: "UTC", local_date: LABEL_DATE, slot: "meal-3", method: "label",
      draft_id: id(), save_label_as_food: true,
      items: [{ id: id(), seq: 0, food_ref_id: LABEL_FOOD_PLACEHOLDER_REF, qty: 1, unit: "whole",
        grams: 90 }],
      label_food: { name: LABEL_NAME, brand: "Serenity", per100g: LABEL_PER_100G,
        ingredientsText: "pear", allergenTags: [] } }, cookie));
    expect(res.status).toBe(200);
    expect(await entryCount(LABEL_DATE)).toBe(1);
    expect(stable(await res.json())).toMatchSnapshot();
  });
});
