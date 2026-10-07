import { beforeEach, describe, expect, it, vi } from "vitest";

/** An awaited query result that a paged read can still chain `.order()`/`.range()` onto. */
function settled(value: unknown) {
  const query: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
  query.order = () => query;
  query.range = () => query;
  return query;
}

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

const { systemOne } = await import("@/lib/ai/typesafe");
const { proposeDraft } = await import("@/lib/server/capture");
const { adviseDraftFoodRoles } = await import("@/lib/server/food-role-advice");
const { MEAL_COMPONENT_ROLES } = await import("@/lib/coach/role-advice");
const { choiceAnswer, fakeClient } = await import("@/tests/helpers/role-advice-fakes");
type Advice = import("@/lib/coach/role-advice").MealComponentRoleAdvice;

const NEW_FOOD = "11111111-1111-4111-8111-111111111111";
const SET_FOOD = "22222222-2222-4222-8222-222222222222";
const LISTED_NO_ROLE = "33333333-3333-4333-8333-333333333333";

const TABLES = () => ({
  user_food_prefs: [
    { user_id: "u1", food_ref_id: SET_FOOD, status: "eats", role: "fat" },
    { user_id: "u1", food_ref_id: LISTED_NO_ROLE, status: "eats", role: null },
  ],
  food_refs: [NEW_FOOD, SET_FOOD, LISTED_NO_ROLE].map((id) => ({ id, catalog_food_id: 5,
    user_food_id: null, user_foods: null })),
  catalog_food_revisions: [{ catalog_food_id: 5, is_active: true, description: "Rice, white",
    prep_state: "cooked", catalog_food_nutrients: [
      { nutrient_code: "protein", amount_per_100g: 2.7 },
      { nutrient_code: "carbohydrate", amount_per_100g: 28 },
      { nutrient_code: "fat_total", amount_per_100g: 0.3 }] }],
});

beforeEach(() => { vi.mocked(systemOne).mockReset(); });

describe("adviseDraftFoodRoles (capture draft)", () => {
  it("advises grounded foods with no stored role, on a list or not, and writes nothing", async () => {
    const db = fakeClient(TABLES());
    vi.mocked(systemOne).mockResolvedValue(choiceAnswer("carb_source") as never);

    const advice = await adviseDraftFoodRoles(db.client, "u1", [NEW_FOOD, null, SET_FOOD, LISTED_NO_ROLE]);

    expect([...advice.keys()].sort()).toEqual([NEW_FOOD, LISTED_NO_ROLE]);
    expect(advice.get(NEW_FOOD)).toEqual({ foodRefId: NEW_FOOD, suggestedRole: "carb_source",
      proposedRole: "carb", currentRole: null, reason: MEAL_COMPONENT_ROLES.carb_source,
      confidence: 0.9, requiresConfirmation: true });
    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(db.writes).toEqual([]);
  });

  it("gives no advice when the role is already set", async () => {
    vi.mocked(systemOne).mockResolvedValue(choiceAnswer("carb_source") as never);
    const advice = await adviseDraftFoodRoles(fakeClient(TABLES()).client, "u1", [SET_FOOD]);
    expect(advice.size).toBe(0);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("fails soft: a read error or Jev failure is no advice", async () => {
    vi.mocked(systemOne).mockResolvedValue(choiceAnswer("carb_source") as never);
    const failing = fakeClient(TABLES(), { failTable: "user_food_prefs" });
    await expect(adviseDraftFoodRoles(failing.client, "u1", [NEW_FOOD])).resolves.toEqual(new Map());
    vi.mocked(systemOne).mockImplementation(async () => { throw new Error("down"); });
    await expect(adviseDraftFoodRoles(fakeClient(TABLES()).client, "u1", [NEW_FOOD]))
      .resolves.toEqual(new Map());
  });
});

describe("proposeDraft attaches roleAdvice per draft item", () => {
  const REQ = { method: "text" as const, localDate: "2026-09-11", tz: "America/New_York",
    slot: "meal-1", text: "rice and butter" };
  const ADVICE: Advice = { foodRefId: "ref-70", suggestedRole: "carb_source", proposedRole: "carb",
    currentRole: null, reason: MEAL_COMPONENT_ROLES.carb_source, confidence: 0.9,
    requiresConfirmation: true };

  function db() {
    const chain = (table: string): Record<string, unknown> => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "neq", "gte", "order", "limit", "eq"]) c[m] = vi.fn(() => c);
      c.range = vi.fn(() => settled({ data: [], error: null }));
      c.in = table === "ai_calls" ? vi.fn(() => c) : vi.fn(() => settled({ data: [], error: null }));
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      c.insert = vi.fn(async () => ({ error: null }));
      return c;
    };
    const rpc = vi.fn(async (name: string) => name === "ai_calls_today" ? { data: 0, error: null }
      : name === "get_or_create_food_ref" ? { data: "ref-70", error: null } : { data: null, error: null });
    return { rpc, from: vi.fn(chain) } as never;
  }
  const runCapture = vi.fn(async () => ({ items: [
    { label: "rice", grams: 150, qty: 1, unit: "cup", confidence: 0.8 },
    { label: "mystery", grams: 10, qty: 1, unit: "g", confidence: 0.3 }], notes: [] }));
  const hit = { catalogFoodId: 7, revisionId: 70, description: "Rice, white", brand: null,
    source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: null,
    score: 0.9, prefStatus: null, policyCategories: [], policy: { verdict: "allowed" } };
  // Two hits clear the 0.95/0.30 auto-resolve gate for "rice"; "mystery" finds nothing.
  const searchFoods = vi.fn(async (_c: unknown, q: { q: string }) => ({
    hits: q.q === "rice" ? [{ ...hit, score: 0.96 },
      { ...hit, catalogFoodId: 8, revisionId: 80, description: "Rice, brown", score: 0.6 }] : [],
    queryClass: "generic", autoResolve: null, catalogVersion: "v1" }));

  beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo"); });

  it("puts the advice on the grounded item only, and passes every item's ref", async () => {
    const adviseRoles = vi.fn(async () => new Map([["ref-70", ADVICE]]));
    const out = await proposeDraft(db(), db(), "u1", REQ, {
      runCapture: runCapture as never, searchFoods: searchFoods as never, adviseRoles });

    expect(adviseRoles).toHaveBeenCalledWith(out.items.map((item) => item.foodRefId));
    const rice = out.items.find((item) => item.foodRefId === "ref-70");
    expect(rice?.roleAdvice).toEqual(ADVICE);
    expect(out.items.filter((item) => item.roleAdvice)).toHaveLength(1);
  });

  it("returns the draft with no advice when advice is absent or fails", async () => {
    const none = await proposeDraft(db(), db(), "u1", REQ, { runCapture: runCapture as never,
      searchFoods: searchFoods as never, adviseRoles: async () => new Map() });
    expect(none.items.length).toBeGreaterThan(0);
    expect(none.items.some((item) => "roleAdvice" in item)).toBe(false);

    const failed = await proposeDraft(db(), db(), "u1", REQ, { runCapture: runCapture as never,
      searchFoods: searchFoods as never, adviseRoles: async () => { throw new Error("boom"); } });
    expect(failed.items.map((item) => item.foodRefId)).toEqual(none.items.map((item) => item.foodRefId));
    expect(failed.items.some((item) => "roleAdvice" in item)).toBe(false);
  });

  it("keeps roleAdvice through the coach's capture-draft block schema", async () => {
    const { proposeDraftSchema } = await import("@/lib/coach/ui-blocks");
    const advice = { ...ADVICE, foodRefId: NEW_FOOD };
    const out = await proposeDraft(db(), db(), "u1", REQ, { runCapture: runCapture as never,
      searchFoods: searchFoods as never, adviseRoles: async () => new Map([["ref-70", advice]]) });
    const parsed = proposeDraftSchema.parse(out);
    expect(parsed.items.find((item) => item.foodRefId === "ref-70")?.roleAdvice).toEqual(advice);
  });
});
