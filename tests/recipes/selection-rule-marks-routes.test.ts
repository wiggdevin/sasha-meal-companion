/**
 * F2 (2026-10-05 calculation audit): the selection GET marks every uneaten accepted recipe with
 * its verdict under the CURRENT rules and drops none; the consumed POST still logs (marks never
 * refuse) and answers with the mark.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ marks: vi.fn(), rpc: vi.fn(), tables: {} as Record<string, unknown>,
  errors: {} as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/recipe-candidates", () => ({ acceptedSelectionRuleMarks: mocks.marks }));
vi.mock("@/lib/server/recipe-access", () => ({ requireRecipeUser: vi.fn(async () => ({
  userId: "account", client: {
    rpc: mocks.rpc,
    from: (table: string) => {
      const result = mocks.errors[table] ? { data: null, error: mocks.errors[table] }
        : { data: mocks.tables[table] ?? [], error: null };
      const query: Record<string, unknown> = {
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
        maybeSingle: async () => ({ data: (mocks.tables[table] as unknown[] | undefined)?.[0] ?? null,
          error: null }),
      };
      for (const name of ["select", "eq", "is", "gte", "lte", "order"]) query[name] = () => query;
      return query;
    },
  } })) }));

const { GET } = await import("@/app/api/recipes/plan/route");
const { POST } = await import("@/app/api/recipes/consumed/route");

const row = (id: string, slot: string) => ({ id, local_date: "2026-10-06", slot_id: slot,
  recipe_id: "chicken-bowl", recipe_revision_id: `${id}-rev`, recipe_name: "Chicken bowl",
  serving_fraction: 1, ingredient_snapshot: [], nutrition_snapshot: {},
  exact_fit_available: true, approximate_fit_available: true, evidence_issues: [],
  plan_revision: 1, accepted_at: "2026-10-01T12:00:00Z" });
const vegan = { verdict: "blocked", reason: "chicken breast: does not fit your food rules." };

beforeEach(() => {
  mocks.marks.mockReset(); mocks.rpc.mockReset();
  mocks.tables = {}; mocks.errors = {};
});

describe("accepted selection reads", () => {
  it("marks an uneaten selection, keeps every row, and never re-judges an eaten slot", async () => {
    mocks.tables.recipe_plan_selections = [row("open", "meal-2"), row("eaten", "meal-3")];
    mocks.tables.plan_days = [{ local_date: "2026-10-06",
      eaten_slots: { "meal-3": { eaten_at: "2026-10-06T12:00:00Z", changed_at: "2026-10-06T12:00:00Z" } } }];
    mocks.marks.mockResolvedValue(Object.assign(new Map([["open", vegan]]),
      { preferenceFlags: ["vegan"] }));
    const response = await GET(new Request("http://x/api/recipes/plan?start=2026-10-06&end=2026-10-06"));
    const body = await response.json() as { selections: { id: string; ruleMark: unknown }[] };
    expect(response.status).toBe(200);
    expect(mocks.marks.mock.calls[0][2].map((entry: { id: string }) => entry.id)).toEqual(["open"]);
    expect(body.selections.map(({ id, ruleMark }) => [id, ruleMark])).toEqual([
      ["open", vegan], ["eaten", undefined]]);
    // Eaten history carries no mark at all, so a phone without the eaten mark fails closed.
    expect("ruleMark" in body.selections[1]).toBe(false);
    // The flags the marks were judged under travel with them (round 3 BLOCK).
    expect((body as unknown as { ruleFlags: string[] }).ruleFlags).toEqual(["vegan"]);
  });

  it("reports a selection the check never answered as unknown, not as a pass", async () => {
    mocks.tables.recipe_plan_selections = [row("open", "meal-2")];
    mocks.marks.mockResolvedValue(new Map());
    const response = await GET(new Request("http://x/api/recipes/plan?start=2026-10-06&end=2026-10-06"));
    const body = await response.json() as { selections: { ruleMark: { verdict: string } }[] };
    expect(body.selections[0].ruleMark.verdict).toBe("unknown");
  });
});

describe("accepted selection reads when the eaten read fails (round 2, finding 7)", () => {
  it("marks every row unknown instead of judging eaten slots as open", async () => {
    mocks.tables.recipe_plan_selections = [row("open", "meal-2"), row("eaten", "meal-3")];
    mocks.errors.plan_days = { message: "down" };
    mocks.marks.mockResolvedValue(new Map([["open", null], ["eaten", null]]));
    const response = await GET(new Request("http://x/api/recipes/plan?start=2026-10-06&end=2026-10-06"));
    const body = await response.json() as { selections: { ruleMark: { verdict: string } | null }[] };
    expect(response.status).toBe(200);
    expect(body.selections.map((entry) => entry.ruleMark?.verdict)).toEqual(["unknown", "unknown"]);
  });
});

describe("recipe consumed write", () => {
  it("still logs a recipe that no longer fits and returns its mark", async () => {
    mocks.rpc.mockResolvedValue({ data: { row: { local_date: "2026-10-06" } }, error: null });
    mocks.tables.recipe_plan_selections = [{ id: "11111111-1111-4111-8111-111111111111",
      recipe_revision_id: "rev", ingredient_snapshot: [{ seq: 1, name: "peanuts" }] }];
    mocks.marks.mockResolvedValue(new Map([["11111111-1111-4111-8111-111111111111", vegan]]));
    const response = await POST(new Request("http://x/api/recipes/consumed", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "22222222-2222-4222-8222-222222222222",
        localDate: "2026-10-06", slotId: "meal-2",
        selectionId: "11111111-1111-4111-8111-111111111111", planRevision: 1, actualServings: 1 }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("recipe_log_consumed", expect.anything());
    expect(await response.json()).toEqual({ row: { local_date: "2026-10-06" }, ruleMark: vegan });
    // Round 4 BLOCK 2: the check sees the plan's own snapshot, so a substitution cannot pass.
    expect(mocks.marks.mock.calls[0][2]).toEqual([{ id: "11111111-1111-4111-8111-111111111111",
      recipeRevisionId: "rev", ingredientSnapshot: [{ seq: 1, name: "peanuts" }] }]);
  });

  it("keeps a committed log when the rule check itself fails", async () => {
    mocks.rpc.mockResolvedValue({ data: { row: { local_date: "2026-10-06" } }, error: null });
    mocks.tables.recipe_plan_selections = [{ id: "11111111-1111-4111-8111-111111111111",
      recipe_revision_id: "rev" }];
    mocks.marks.mockRejectedValue(new Error("down"));
    const response = await POST(new Request("http://x/api/recipes/consumed", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "22222222-2222-4222-8222-222222222222",
        localDate: "2026-10-06", slotId: "meal-2",
        selectionId: "11111111-1111-4111-8111-111111111111", planRevision: 1, actualServings: 1 }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).ruleMark.verdict).toBe("unknown");
  });
});
