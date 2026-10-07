/**
 * Acceptance 9 and 10, plus the CSV-injection guard on a real food name. [needs branch]
 *
 * Corrections from the SDD ledger's Rulings (progress.md):
 * R3 — auth is a session Cookie header (pointRequestClientAtBranch + sessionCookieFor), not a
 * Bearer token: requireUser's createRequestClient reads Cookie only.
 * R5 — resetRateLimits() in beforeEach: this suite's many authenticated GETs would otherwise trip
 * the 10/hour per-user limit.
 * R6 — a second single-item entry on an unused local_date (2026-09-15) makes the paging test
 * deterministic: page 1 is exactly one row regardless of other suites' data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/lib/store";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { dropCatalogFoods, pointRequestClientAtBranch, seedCatalogFood, sessionCookieFor, uuid } from "../log/fixtures";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";

// lib/server/export.ts imports "server-only" (see tests/log/commit.test.ts for the precedent):
// only the marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { GET } = await import("../../app/api/export/route");
const { applyLogEntry } = await import("@/lib/server/log");
const { writeDerivedTargets } = await import("@/lib/server/targets");

const run = HAS_BRANCH ? describe : describe.skip;
const DATE = "2026-09-21";
const DATE2 = "2026-09-15";

function get(query: string, cookie?: string): Request {
  return new Request(`https://app.test/api/export?${query}`,
    { headers: cookie ? { cookie, ...accountHeaderFromCookie(cookie) } : {} });
}

run("GET /api/export streaming kinds", () => {
  let cookie = "";
  let admin: SupabaseClient;
  /** The account's own revision — the only source of a progress row's target (D1 §5). */
  let target: { revision: number; trainingKcal: number };

  beforeAll(async () => {
    pointRequestClientAtBranch();
    const users = await createTestUsers();
    const a = users.a;
    admin = users.admin;
    const chicken = await seedCatalogFood(admin, a.userId, { sourceId: "export-1",
      description: "Chicken thigh, roasted", brand: "Store brand",
      per100g: { energy_kcal: 179, protein: 23.1, carbohydrate: 0, fat_total: 9.3,
        fiber_total: 0 } });
    // A row-less account exports an empty target column, so this file seeds the first revision
    // through the same derived path onboarding uses (there is no code fallback left).
    const seeded = await writeDerivedTargets(a.client, a.userId, {
      settings: { ...defaultSettings(), sex: "female", birthYear: 1996, heightCm: 165,
        weightKg: 60, activityLevel: "moderate", goal: "recomp" },
      latestWeighInKg: null, today: "2026-09-01", trainingWeekdays: [1, 3, 4, 5],
    });
    target = { revision: seeded.revision, trainingKcal: seeded.training.kcal };
    const formula = await seedCatalogFood(admin, a.userId, { sourceId: "export-2",
      description: "=SUM(A1) salad mix", per100g: { energy_kcal: 20, protein: 1.5,
        fiber_total: 1.8 } });
    await applyLogEntry(a.client, a.userId, { entry_id: uuid(501),
      eaten_at: `${DATE}T18:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
      method: "search", note: "after the gym",
      items: [{ id: uuid(511), seq: 1, food_ref_id: chicken.foodRefId, qty: 1, unit: "g",
        grams: 140 }, { id: uuid(512), seq: 2, food_ref_id: formula.foodRefId, qty: 1,
        unit: "g", grams: 80 }] });
    // R6: a second, single-item entry on an unused date so the paging test does not depend on
    // how many rows other suites happened to leave behind.
    await applyLogEntry(a.client, a.userId, { entry_id: uuid(502),
      eaten_at: `${DATE2}T18:00:00.000Z`, tz: "UTC", local_date: DATE2, slot: "meal-1",
      method: "search",
      items: [{ id: uuid(513), seq: 1, food_ref_id: chicken.foodRefId, qty: 1, unit: "g",
        grams: 100 }] });
    cookie = await sessionCookieFor(a.client);
  });

  afterAll(async () => {
    await dropCatalogFoods(admin, "export-");
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("returns one CSV row per logged item with grams, source and source version", async () => {
    const res = await GET(get(`kind=meals&format=csv&from=${DATE}&to=${DATE}`, cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition"))
      .toBe(`attachment; filename="meal-companion-meals-${DATE}-${DATE}.csv"`);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("local_date,eaten_at,tz,slot,entry_id,item_seq,food_name,brand," +
      "source,source_version,food_revision_id,qty,unit,grams,energy_kcal,energy_kcal_source," +
      "protein_g," +
      "carbohydrate_g,fat_g,fiber_g,note,nutrition_partial");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",fdc_branded,test-1,");
    expect(lines[1]).toContain(",140,250.6,reported,32.34,0,13.02,0,");
  });

  it("prefixes a food name that starts with an equals sign", async () => {
    // architecture.md §4.6: "CSV cells beginning = + - @ are prefixed with '" — no forced
    // quoting beyond that. escapeCell (lib/export/csv.ts, frozen since Phase 0) only quotes a
    // cell that also has a comma, quote or newline, and "salad mix" has none, so the brief's
    // literal `"'=SUM(A1) salad mix"` (quoted) never matches; asserted here as the unquoted,
    // comma-delimited cell the shared escapeCell actually produces.
    const res = await GET(get(`kind=meals&format=csv&from=${DATE}&to=${DATE}`, cookie));
    expect(await res.text()).toContain(",'=SUM(A1) salad mix,");
  });

  it("returns one progress row per local date with the target and coverage", async () => {
    const res = await GET(get(`kind=progress&format=csv&from=${DATE}&to=${DATE}`, cookie));
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("local_date,day_type,target_revision,kcal_target,energy_kcal," +
      "energy_kcal_source,protein_g," +
      "carbohydrate_g,fat_g,fiber_g,micro_coverage_pct,items_logged,partial_recipe_items");
    expect(lines).toHaveLength(2);
    // Rewritten, not dropped: the old shape (an empty revision with a numeric target) was the
    // deleted ramp. The row now carries the account's own revision, and DATE is a Monday the
    // seeded revision trains, so the target is that revision's training kcal.
    expect(lines[1]).toMatch(
      new RegExp(String.raw`^${DATE},training-10,${target.revision},${target.trainingKcal},`));
    // items_logged 2, then partial_recipe_items 0 (no recipe in this fixture).
    expect(lines[1].endsWith(",2,0")).toBe(true);
  });

  it("returns json with a cursor field and no notice for non-OFF rows", async () => {
    const res = await GET(get(`kind=meals&format=json&from=${DATE}&to=${DATE}`, cookie));
    const out = await res.json();
    expect(out.rows).toHaveLength(2);
    expect(out.next_cursor).toBeNull();
    expect(out.notices).toEqual([]);
  });

  it("pages without a gap or a duplicate", async () => {
    const first = await (await GET(
      get(`kind=meals&format=json&from=${DATE2}&to=${DATE}&limit=1`, cookie))).json();
    expect(first.rows).toHaveLength(1);
    const second = await (await GET(get(
      `kind=meals&format=json&from=${DATE2}&to=${DATE}&limit=1&cursor=${first.next_cursor}`,
      cookie))).json();
    expect(second.rows[0]?.entry_id).not.toBe(first.rows[0].entry_id);
  });

  it("400s an unknown kind or format and 422s a bad date, cursor or limit", async () => {
    expect((await GET(get("kind=nonsense&format=json", cookie))).status).toBe(400);
    expect((await GET(get("kind=meals&format=xml", cookie))).status).toBe(400);
    expect((await GET(get("kind=meals&format=json&from=17-09-2026", cookie))).status).toBe(422);
    expect((await GET(get("kind=meals&format=json&cursor=zzz", cookie))).status).toBe(422);
    expect((await GET(get("kind=meals&format=json&limit=9000", cookie))).status).toBe(422);
  });

  it("401s with no session", async () => {
    expect((await GET(get("kind=meals"))).status).toBe(401);
  });

  it("serves Phase 0's body-weight export at the renamed kind=weight, not kind=progress", async () => {
    const weight = await GET(get("kind=weight&format=json", cookie));
    expect(weight.status).toBe(200);
    expect(await weight.json()).toMatchObject({ rows: [], next_page: null });
    // kind=progress is the new nutrient-totals meaning (asserted above), never weigh_ins —
    // the two must never collide again.
    const progress = await GET(get(`kind=progress&format=json&from=${DATE}&to=${DATE}`, cookie));
    const progressBody = await progress.json();
    expect(progressBody.rows[0]).not.toHaveProperty("value");   // weigh_ins' column, not totals'
    expect(progressBody.rows[0]).toHaveProperty("energy_kcal");
  });
});
