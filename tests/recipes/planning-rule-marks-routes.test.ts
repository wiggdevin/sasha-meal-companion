/**
 * The planning routes answer with `ruleMark` (and the flags it was judged under): the recipe
 * search and detail GETs per recipe, the accept POST on its selection, failing closed to unknown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { recipe } from "./fixture";

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(), detail: vi.fn(), selectionMark: vi.fn(), accept: vi.fn(), preview: vi.fn(),
  previewRow: { kind: "recipe", proof: { choices: [{ recipeId: "" }] } } as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/recipe-candidates", async (original) => ({
  ...(await original<typeof import("@/lib/server/recipe-candidates")>()),
  loadMarkedRecipeCandidates: mocks.candidates, loadMarkedRecipeDetail: mocks.detail,
  acceptedSelectionRuleMark: mocks.selectionMark,
}));
vi.mock("@/lib/server/recipe-plan", () => ({ acceptPreview: mocks.accept, previewRecipe: mocks.preview,
  noStore: { "Cache-Control": "no-store" } }));
vi.mock("@/lib/server/recipe-access", () => ({ requireRecipeUser: vi.fn(async () => ({
  userId: "account", client: { from: () => {
    const query: Record<string, unknown> = {
      maybeSingle: async () => ({ data: mocks.previewRow, error: null }),
    };
    for (const name of ["select", "eq"]) query[name] = () => query;
    return query;
  } } })) }));

const search = await import("@/app/api/recipes/route");
const detail = await import("@/app/api/recipes/[id]/route");
const plan = await import("@/app/api/recipes/[id]/plan/route");
const previewRoute = await import("@/app/api/recipes/[id]/preview/route");
const { RecipeRulesUnchecked, withRuleMark } = await import("@/lib/server/recipe-candidates");

const RECIPE_ID = "33333333-3333-4333-8333-333333333333";
const clear: RecipeCandidate = { ...recipe({ revisionId: "rev" }),
  eligibility: { status: "eligible", reasons: [] } };
const blocked: RecipeCandidate = { ...recipe({ revisionId: "rev-2" }), eligibility: {
  status: "blocked", reasons: [{ code: "avoid_list", message: "Peanuts are on your Avoid list." }] } };

beforeEach(() => {
  for (const fn of [mocks.candidates, mocks.detail, mocks.selectionMark, mocks.accept, mocks.preview]) {
    fn.mockReset();
  }
  mocks.previewRow = { kind: "recipe", proof: { choices: [{ recipeId: RECIPE_ID }] } };
});

describe("GET /api/recipes", () => {
  it("marks every candidate under the current rules and names the flags", async () => {
    mocks.candidates.mockResolvedValue({ candidates: [clear, blocked].map(withRuleMark), noResultReasons: [],
      rulesFingerprint: "fp", preferenceFlags: ["vegan"] });
    const response = await search.GET(new Request("http://x/api/recipes?q=stew"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.recipes.map((row: { ruleMark: unknown }) => row.ruleMark)).toEqual([
      null, { verdict: "blocked", reason: "Peanuts are on your Avoid list." }]);
    expect(body.ruleFlags).toEqual(["vegan"]);
    expect(body.count).toBe(2);
  });
});

describe("GET /api/recipes/[id]", () => {
  it("returns the recipe with its mark and flags", async () => {
    mocks.detail.mockResolvedValue({ recipe: withRuleMark(blocked), rulesFingerprint: "fp",
      preferenceFlags: [] });
    const response = await detail.GET(new Request(`http://x/api/recipes/${RECIPE_ID}`),
      { params: Promise.resolve({ id: RECIPE_ID }) });
    const body = await response.json();
    expect(body.ruleMark).toEqual({ verdict: "blocked", reason: "Peanuts are on your Avoid list." });
    expect(body.ruleFlags).toEqual([]);
    expect(body.revisionId).toBe("rev-2");
  });
});

const unknown = { verdict: "unknown" as const,
  reason: "This recipe could not be checked against your current food rules." };

describe("rule read failures answer in band", () => {
  it("search and detail still return the recipes, marked unknown, with no ruleFlags", async () => {
    mocks.candidates.mockResolvedValue({ candidates: [{ ...clear, ruleMark: unknown }],
      noResultReasons: [unknown.reason], rulesFingerprint: null });
    const listed = await (await search.GET(new Request("http://x/api/recipes?q=stew"))).json();
    expect(listed.recipes[0].ruleMark).toEqual(unknown);
    expect("ruleFlags" in listed).toBe(false);
    mocks.detail.mockResolvedValue({ recipe: { ...clear, ruleMark: unknown }, rulesFingerprint: null });
    const res = await detail.GET(new Request(`http://x/api/recipes/${RECIPE_ID}`),
      { params: Promise.resolve({ id: RECIPE_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruleMark).toEqual(unknown);
    expect("ruleFlags" in body).toBe(false);
  });

  it("preview answers the explicit 422 recipe_rules_unchecked carrying the unknown mark", async () => {
    mocks.preview.mockRejectedValue(new RecipeRulesUnchecked(unknown));
    const res = await previewRoute.POST(new Request(`http://x/api/recipes/${RECIPE_ID}/preview`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-06", slotId: "meal-2" }),
    }), { params: Promise.resolve({ id: RECIPE_ID }) });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "recipe_rules_unchecked", message: unknown.reason,
      ruleMark: unknown });
  });
});

describe("POST /api/recipes/[id]/plan", () => {
  const post = () => plan.POST(new Request(`http://x/api/recipes/${RECIPE_ID}/plan`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId: "44444444-4444-4444-8444-444444444444",
      requestId: "55555555-5555-4555-8555-555555555555", acceptApproximate: false }),
  }), { params: Promise.resolve({ id: RECIPE_ID }) });
  const selection = { id: "sel", recipeRevisionId: "rev", ingredientSnapshot: [] };

  it("answers the accepted selection with its current-rules mark and flags", async () => {
    mocks.accept.mockResolvedValue({ selections: [selection] });
    mocks.selectionMark.mockResolvedValue({ ruleMark: { verdict: "unknown",
      reason: "A substituted ingredient has not been checked against your current food rules." },
    preferenceFlags: ["no_peanuts"] });
    const response = await post();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.selection).toMatchObject({ id: "sel", ruleMark: { verdict: "unknown" } });
    expect(body.ruleFlags).toEqual(["no_peanuts"]);
    expect(mocks.selectionMark).toHaveBeenCalledWith(expect.anything(), "account", selection);
  });

  it("keeps a clear mark as null and omits flags the check could not read", async () => {
    mocks.accept.mockResolvedValue({ selections: [selection] });
    mocks.selectionMark.mockResolvedValue({ ruleMark: null });
    const body = await (await post()).json();
    expect(body.selection.ruleMark).toBeNull();
    expect("ruleMark" in body.selection).toBe(true);
    expect("ruleFlags" in body).toBe(false);
  });
});
