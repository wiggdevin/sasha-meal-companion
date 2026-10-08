import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), profile: vi.fn(), evidence: vi.fn(), createLine: vi.fn(), patchLine: vi.fn(),
  putPantry: vi.fn(), preview: vi.fn(), accept: vi.fn(),
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/server/recipe-plan", () => ({ noStore: { "Cache-Control": "no-store" },
  previewShopping: mocks.preview, acceptPreview: mocks.accept }));
vi.mock("@/lib/server/recipe-access", () => ({ requireRecipeUser: mocks.auth }));
vi.mock("@/lib/server/policy-profile", () => ({ readPolicyProfile: mocks.profile }));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: mocks.evidence,
}));
vi.mock("@/lib/shopping/repository", async (original) => ({
  ...(await original<typeof import("@/lib/shopping/repository")>()),
  createLine: mocks.createLine, patchLine: mocks.patchLine, putPantry: mocks.putPantry,
}));

import { GET as getPeriodRoute } from "@/app/api/shopping/periods/[id]/route";
import { POST as postLine } from "@/app/api/shopping/periods/[id]/lines/route";
import { GET as getPantry, PUT as putPantryRoute } from "@/app/api/shopping/pantry/route";
import { PATCH as patchLineRoute } from "@/app/api/shopping/periods/[id]/lines/[lineId]/route";
import { POST as previewRoute } from "@/app/api/shopping/preview/route";
import { POST as acceptRoute } from "@/app/api/shopping/accept/route";
import { loadShoppingRuleContext } from "@/lib/server/shopping-rule-marks";
import { withShoppingRuleMarks } from "@/lib/shopping/rule-marks";

const userId = "00000000-0000-4000-8000-000000000001";
const periodId = "00000000-0000-4000-8000-0000000000f1";
const pbRef = "00000000-0000-4000-8000-0000000000a1";
const riceRef = "00000000-0000-4000-8000-0000000000a2";

type Call = { table: string; method: string; args: unknown[] };
/** Records every chained call; a terminal read returns that table's rows. */
/** An Error in place of a table's rows makes every read of that table fail. */
function recordingClient(tables: Record<string, unknown[] | Error>, calls: Call[]): SupabaseClient {
  return { from: (table: string) => {
    const entry = tables[table] ?? [];
    const failed = entry instanceof Error ? entry : null;
    const rows = entry instanceof Error ? [] : entry;
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "is", "order", "gte", "lte", "limit", "range"]) {
      query[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return query; };
    }
    query.maybeSingle = async () => ({ data: failed ? null : rows[0] ?? null, error: failed });
    query.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: failed ? null : rows, error: failed }).then(resolve);
    return query;
  } } as unknown as SupabaseClient;
}

const periodRow = { id: periodId, user_id: userId, start_date: "2026-10-05", end_date: "2026-10-11",
  timezone: "UTC", people: 1, meal_coverage: ["meal-1"], mode: "simple", effort: "none",
  max_active_minutes: null, variety: "balanced", budget_amount: null, currency: null, locale: null,
  lock_mode: "none", plan_revision: 1, rev: 1 };
function lineRow(id: string, name: string, foodRefId: string | null) {
  return { id, period_id: periodId, user_id: userId, origin: foodRefId ? "plan" : "manual", name,
    identity: foodRefId ? { foodRefId, catalogFoodRevisionId: 7, purchaseState: "as_purchased",
      variantKey: "default" } : null,
    category: foodRefId ? "core" : "manual", need_grams: null, confirmed_stock_grams: null,
    buy_grams: null, package_grams: null, purchase_conversion_status: "unknown", sources: [],
    pinned: false, checked: false, note: null, rev: 1 };
}
const facts = (over: Record<string, unknown>) => ({ allergenTags: [], allergenEvidence: {},
  checkedAllergens: [], ingredientsText: null, foodName: null, foodBrand: null, packaged: false,
  policyCategories: [], facets: {}, noCook: null, onEatsList: false, onAvoidList: false,
  role: null, ...over });

let calls: Call[];
beforeEach(() => {
  calls = [];
  mocks.profile.mockReset().mockResolvedValue({ profile: { ...EMPTY_PROFILE,
    avoid_allergens: ["peanut"] }, rev: 2, instances: [] });
  mocks.evidence.mockReset().mockResolvedValue({ status: "ready", preferenceFlags: [], byIdentity: {
    [`ref:${pbRef}`]: facts({ allergenTags: ["peanut"], foodName: "Peanut butter" }),
    [`ref:${riceRef}`]: facts({ foodName: "Rice, white, cooked",
      allergenEvidence: { peanut: { level: "not_listed", labelComplete: true } } }),
  } });
  for (const mock of [mocks.createLine, mocks.patchLine, mocks.putPantry, mocks.preview,
    mocks.accept]) mock.mockReset();
});

function mapped(row: ReturnType<typeof lineRow>) {
  return { id: row.id, periodId, origin: row.origin, name: row.name, identity: row.identity,
    category: row.category, needGrams: null, confirmedStockGrams: null, buyGrams: null,
    packageGrams: null, purchaseConversionStatus: "unknown", sources: [], pinned: false,
    checked: false, note: null, revision: 1 };
}
function json(body: unknown, method = "POST"): Request {
  return new Request("http://test", { method, headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}
type Marked = { name: string; ruleMark: unknown };

describe("shopping routes attach current-rule marks", () => {
  it("marks existing dated lines on the period read, with one evidence load", async () => {
    const client = recordingClient({ shopping_periods: [periodRow], shopping_lines: [
      lineRow("00000000-0000-4000-8000-0000000000b1", "Peanut butter", pbRef),
      lineRow("00000000-0000-4000-8000-0000000000b2", "Rice", riceRef),
      lineRow("00000000-0000-4000-8000-0000000000b3", "paper towels", null),
    ], shopping_purchase_windows: [], user_food_prefs: [] }, calls);
    mocks.auth.mockResolvedValue({ client, userId });
    const response = await getPeriodRoute(new Request(`http://test/api/shopping/periods/${periodId}`),
      { params: Promise.resolve({ id: periodId }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { lines: { name: string; ruleMark: unknown }[] };
    expect(body.lines.map((line) => [line.name, line.ruleMark])).toEqual([
      ["Peanut butter", { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." }],
      ["Rice", null],
      ["paper towels", null],
    ]);
    expect(mocks.evidence).toHaveBeenCalledTimes(1);
    expect(mocks.evidence.mock.calls[0][0]).toBe(userId);
    // Ownership is unchanged: every shopping and Avoid read stays scoped to the signed-in account.
    for (const table of ["shopping_periods", "shopping_lines", "shopping_purchase_windows",
      "user_food_prefs"]) {
      expect(calls.some((call) => call.table === table && call.method === "eq"
        && call.args[0] === "user_id" && call.args[1] === userId)).toBe(true);
    }
  });

  it("accepts a manual peanut-butter line and returns it marked", async () => {
    const client = recordingClient({ user_food_prefs: [] }, calls);
    mocks.auth.mockResolvedValue({ client, userId });
    const draft = { origin: "manual", name: "peanut butter", identity: null, category: "manual",
      needGrams: null, confirmedStockGrams: null, buyGrams: null, packageGrams: null,
      purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null };
    mocks.createLine.mockImplementation(async (_client, _user, period, line) => ({
      ...line, id: "00000000-0000-4000-8000-0000000000c1", periodId: period, revision: 1 }));
    const response = await postLine(new Request("http://test", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), line: draft }) }),
    { params: Promise.resolve({ id: periodId }) });
    expect(response.status).toBe(201);
    expect(mocks.createLine).toHaveBeenCalledWith(client, userId, periodId,
      expect.objectContaining({ name: "peanut butter" }), expect.any(String));
    const body = await response.json() as { line: { ruleMark: unknown } };
    expect(body.line.ruleMark).toMatchObject({ verdict: "blocked" });
  });

  it("accepts a non-food manual line with no mark", async () => {
    mocks.auth.mockResolvedValue({ client: recordingClient({}, calls), userId });
    mocks.createLine.mockImplementation(async (_client, _user, period, line) => ({
      ...line, id: "00000000-0000-4000-8000-0000000000c2", periodId: period, revision: 1 }));
    const response = await postLine(new Request("http://test", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), line: { origin: "manual",
        name: "paper towels", identity: null, category: "manual", needGrams: null,
        confirmedStockGrams: null, buyGrams: null, packageGrams: null,
        purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false,
        note: null } }) }), { params: Promise.resolve({ id: periodId }) });
    expect(response.status).toBe(201);
    expect((await response.json() as { line: { ruleMark: unknown } }).line.ruleMark).toBeNull();
  });

  it("marks confirmed pantry items and still answers when the rules cannot be read", async () => {
    const pantryRow = { id: "00000000-0000-4000-8000-0000000000d1", user_id: userId,
      name: "Peanut butter", identity: { foodRefId: pbRef, catalogFoodRevisionId: 7,
        purchaseState: "as_purchased", variantKey: "default" },
      confirmed_grams: 340, confirmed_at: "2026-10-01T00:00:00Z", rev: 1 };
    mocks.auth.mockResolvedValue({ client: recordingClient({ shopping_pantry: [pantryRow],
      user_food_prefs: [] }, calls), userId });
    let response = await getPantry(new Request("http://test/api/shopping/pantry"));
    expect(((await response.json()) as { items: { ruleMark: unknown }[] }).items[0].ruleMark)
      .toMatchObject({ verdict: "blocked" });
    mocks.profile.mockRejectedValueOnce(new Error("constraint read failed"));
    response = await getPantry(new Request("http://test/api/shopping/pantry"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: { ruleMark: unknown }[] }).items[0].ruleMark)
      .toMatchObject({ verdict: "unknown" });
  });

  it("marks a typed line from an Avoid name loaded through the account's own foods", async () => {
    const avoidRef = "00000000-0000-4000-8000-0000000000a9";
    const client = recordingClient({ shopping_periods: [periodRow], shopping_lines: [
      lineRow("00000000-0000-4000-8000-0000000000b4", "granola", null),
      lineRow("00000000-0000-4000-8000-0000000000b5", "paper towels", null),
    ], shopping_purchase_windows: [],
    user_food_prefs: [{ food_ref_id: avoidRef, status: "avoid" }],
    food_refs: [{ id: avoidRef, kind: "user", catalog_food_id: null, user_food_id: "uf-1" }],
    user_foods: [{ name: "Granola" }] }, calls);
    mocks.auth.mockResolvedValue({ client, userId });
    mocks.profile.mockResolvedValue({ profile: EMPTY_PROFILE, rev: 1, instances: [] });
    const response = await getPeriodRoute(new Request("http://test"),
      { params: Promise.resolve({ id: periodId }) });
    const body = await response.json() as { lines: Marked[] };
    expect(body.lines.map((line) => [line.name, line.ruleMark])).toEqual([
      ["granola", { verdict: "blocked", reason: "granola is on your Avoid list." }],
      ["paper towels", null],
    ]);
    expect(calls.some((call) => call.table === "user_foods" && call.method === "eq"
      && call.args[0] === "user_id" && call.args[1] === userId)).toBe(true);
  });

  it("keeps typed-text marks when the evidence read throws", async () => {
    const client = recordingClient({ shopping_periods: [periodRow], shopping_lines: [
      lineRow("00000000-0000-4000-8000-0000000000b6", "peanut butter", null),
      lineRow("00000000-0000-4000-8000-0000000000b7", "paper towels", null),
      lineRow("00000000-0000-4000-8000-0000000000b8", "Rice", riceRef),
    ], shopping_purchase_windows: [], user_food_prefs: [] }, calls);
    mocks.auth.mockResolvedValue({ client, userId });
    mocks.evidence.mockRejectedValueOnce(new Error("evidence read failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await getPeriodRoute(new Request("http://test"),
      { params: Promise.resolve({ id: periodId }) });
    warn.mockRestore();
    const body = await response.json() as { lines: Marked[] };
    expect(body.lines.map((line) => [line.name,
      (line.ruleMark as { verdict?: string } | null)?.verdict ?? null])).toEqual([
      ["peanut butter", "blocked"], ["paper towels", null], ["Rice", "unknown"],
    ]);
  });

  it("marks the line a PATCH returns and the item a pantry PUT returns", async () => {
    mocks.auth.mockResolvedValue({ client: recordingClient({}, calls), userId });
    const pb = mapped(lineRow("00000000-0000-4000-8000-0000000000b9", "Peanut butter", pbRef));
    mocks.patchLine.mockResolvedValue({ ...pb, checked: true, revision: 2 });
    let response = await patchLineRoute(json({ expectedRevision: 1,
      requestId: crypto.randomUUID(), patch: { checked: true } }, "PATCH"),
    { params: Promise.resolve({ id: periodId, lineId: pb.id }) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { line: Marked }).line.ruleMark)
      .toMatchObject({ verdict: "blocked" });
    mocks.putPantry.mockImplementation(async (_c, user, item) => ({ ...item,
      id: "00000000-0000-4000-8000-0000000000d2", userId: user, source: "manual" as const,
      confirmedAt: "2026-10-05T00:00:00Z", revision: 1 }));
    response = await putPantryRoute(json({ requestId: crypto.randomUUID(), expectedRevision: null,
      item: { name: "Rice", identity: { foodRefId: riceRef, catalogFoodRevisionId: 7,
        purchaseState: "as_purchased", variantKey: "default" }, confirmedGrams: 500 } }, "PUT"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { item: Marked }).item.ruleMark).toBeNull();
  });

  it("marks preview and accept lines, and an accept with no lines still answers", async () => {
    mocks.auth.mockResolvedValue({ client: recordingClient({
      recipe_plan_previews: [{ kind: "shopping" }] }, calls), userId });
    const pb = mapped(lineRow("00000000-0000-4000-8000-0000000000ba", "Peanut butter", pbRef));
    mocks.preview.mockResolvedValue({ previewId: "p", lines: [pb], choices: [] });
    let response = await previewRoute(json({ draft: { startDate: "2026-10-05",
      endDate: "2026-10-11", timezone: "UTC", people: 1, mealCoverage: ["meal-1"],
      mode: "simple", effort: "none", maxActiveMinutes: null, variety: "balanced",
      budgetAmount: null, currency: null, locale: null, lockMode: "none" }, basket: [] }));
    expect(response.status).toBe(200);
    const preview = await response.json() as { previewId: string; lines: Marked[] };
    expect(preview.previewId).toBe("p");
    expect(preview.lines[0].ruleMark).toMatchObject({ verdict: "blocked" });

    mocks.accept.mockResolvedValue({ period: null, lines: [pb], purchaseWindows: [], selections: [] });
    const acceptBody = { previewId: "00000000-0000-4000-8000-0000000000fa",
      requestId: crypto.randomUUID() };
    response = await acceptRoute(json(acceptBody));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { lines: Marked[] }).lines[0].ruleMark)
      .toMatchObject({ verdict: "blocked" });
    mocks.accept.mockResolvedValue({ period: null, purchaseWindows: [], selections: [] });
    response = await acceptRoute(json(acceptBody));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { lines: unknown[] }).lines).toEqual([]);
  });

  it("never reads a failed evidence or Avoid read as no rules", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const lines = [
      lineRow("00000000-0000-4000-8000-0000000000bb", "Rice", riceRef),
      lineRow("00000000-0000-4000-8000-0000000000bc", "peanut butter", null),
      lineRow("00000000-0000-4000-8000-0000000000bd", "paper towels", null),
    ];
    const read = async (tables: Record<string, unknown[] | Error>) => {
      mocks.auth.mockResolvedValue({ client: recordingClient({ shopping_periods: [periodRow],
        shopping_lines: lines, shopping_purchase_windows: [], ...tables }, calls), userId });
      const response = await getPeriodRoute(new Request("http://test"),
        { params: Promise.resolve({ id: periodId }) });
      expect(response.status).toBe(200);
      return ((await response.json()) as { lines: Marked[] }).lines.map((line) =>
        (line.ruleMark as { verdict?: string } | null)?.verdict ?? null);
    };
    // No rules in the profile, and the evidence (with the preference flags) failed.
    mocks.profile.mockResolvedValue({ profile: EMPTY_PROFILE, rev: 1, instances: [] });
    mocks.evidence.mockResolvedValue({ status: "unavailable", preferenceFlags: [], byIdentity: {} });
    expect(await read({ user_food_prefs: [] })).toEqual(["unknown", null, null]);
    // The peanut rule was read; the Avoid list failed part-way, so other typed text is unproven.
    mocks.profile.mockResolvedValue({ profile: { ...EMPTY_PROFILE, avoid_allergens: ["peanut"] },
      rev: 2, instances: [] });
    mocks.evidence.mockResolvedValue({ status: "ready", preferenceFlags: [], byIdentity: {} });
    expect(await read({ user_food_prefs: [{ food_ref_id: "x", status: "avoid" }],
      food_refs: new Error("too large") })).toEqual(["unknown", "blocked", "unknown"]);
    warn.mockRestore();
    expect(calls.some((call) => call.table === "user_food_prefs" && call.method === "range"))
      .toBe(true);
  });

  it("reads two pins of one ref separately and judges each on its own revision", async () => {
    mocks.evidence.mockImplementation(async (_user: string,
      items: { foodRefId: string; catalogFoodRevisionId: number | null }[]) => ({
      status: "ready", preferenceFlags: [], byIdentity: Object.fromEntries(items.map((item) =>
        [`ref:${item.foodRefId}`, facts(item.catalogFoodRevisionId === 1
          ? { foodName: "Spread", allergenTags: ["peanut"] }
          : { foodName: "Spread", allergenEvidence: {
            peanut: { level: "not_listed", labelComplete: true } } })])) }));
    const pin = (rev: number) => ({ name: "Spread", identity: { foodRefId: pbRef,
      catalogFoodRevisionId: rev, purchaseState: "as_purchased" as const, variantKey: "default" } });
    const items = [pin(1), pin(2)];
    const context = await loadShoppingRuleContext(recordingClient({ user_food_prefs: [] }, calls),
      userId, items);
    expect(mocks.evidence.mock.calls.map((call) =>
      (call[1] as { catalogFoodRevisionId: number }[]).map((item) => item.catalogFoodRevisionId)))
      .toEqual([[1], [2]]);
    expect(withShoppingRuleMarks(items, context).map((item) => item.ruleMark?.verdict ?? null))
      .toEqual(["blocked", null]);
  });

  it("pages a full Avoid page and reads catalog Avoid names", async () => {
    mocks.profile.mockResolvedValue({ profile: EMPTY_PROFILE, rev: 1, instances: [] });
    const full = Array.from({ length: 1000 }, (_, index) => ({
      food_ref_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, status: "avoid" }));
    let page = 0;
    const base = recordingClient({
      food_refs: [{ id: full[0].food_ref_id, kind: "catalog", catalog_food_id: 42,
        user_food_id: null }],
      catalog_food_revisions: [{ description: "Granola, homemade" }],
    }, calls);
    const client = { from: (table: string) => {
      if (table !== "user_food_prefs") return base.from(table);
      const rows = page++ === 0 ? full : [];
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "range"]) {
        query[method] = (...args: unknown[]) => {
          calls.push({ table, method, args }); return query;
        };
      }
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve);
      return query;
    } } as unknown as SupabaseClient;
    const items = [{ name: "granola", identity: null }, { name: "paper towels", identity: null }];
    const context = await loadShoppingRuleContext(client, userId, items);
    expect(calls.filter((call) => call.table === "user_food_prefs" && call.method === "range")
      .map((call) => call.args)).toEqual([[0, 999], [1000, 1999]]);
    expect(context.avoid?.refIds.size).toBe(1000);
    expect(withShoppingRuleMarks(items, context).map((item) => item.ruleMark?.verdict ?? null))
      .toEqual(["blocked", null]);
  });
});
