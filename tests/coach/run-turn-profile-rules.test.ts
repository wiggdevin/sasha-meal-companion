/**
 * Phase 13 slice 4 (§4, §9 R5): an account's CONFIRMED dietary-profile hard rules reach the coach
 * turn's evaluatePolicy. The rules are read once, beside the constraint profile, and the suggestion
 * fast path (suggest_options → filterSuggestionCandidates) judges each candidate against them with
 * the cached facets it read for them. A confirmed religious "pork" rule blocks a pork suggestion;
 * an unconfirmed medical (user_confirmed_safety) rule on the same facet does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentResult } from "@/lib/coach/intent";
import type { SuggestionEvidence } from "@/lib/coach/suggest-policy";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const { evidenceMock } = vi.hoisted(() => ({ evidenceMock: vi.fn() }));

vi.mock("@/lib/ai/typesafe", () => ({
  choice: (instructions: string, criteria: Record<string, string>) => ({
    type: "choice", instructions, criteria,
  }),
  noul: (instructions: string) => ({ type: "noul", instructions }),
  systemOne: async () => ({}),
}));
vi.mock("@/lib/server/catalog-names", () => ({ sameNameRefIds: async () => [] }));
vi.mock("@/lib/server/day-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/day-context")>(),
  buildDayContext: async () => ({
    date: "2026-09-19", dayType: "rest", targets: null, slots: [], entries: [],
    consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    remaining: { kcal: 400, protein: 50, carbs: 0, fat: 20 }, stillToEat: "",
  }),
}));
vi.mock("@/lib/server/coach-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/coach-context")>(),
  foodLists: async () => ({ eats: ["Pork chop"], avoid: [], eatsMore: 0, avoidMore: 0 }),
  eatsForSuggestions: async () => ({ all: ["Pork chop"], anchors: ["Pork chop"] }),
}));
vi.mock("@/lib/server/catalog", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/catalog")>(),
  searchFoods: async () => ({ catalogVersion: 1, hits: [{
    catalogFoodId: 1, description: "Pork chop", brand: null, prefStatus: "eats",
    policy: { verdict: "allowed" },
  }] }),
  getFoodDetail: async () => ({
    revisionId: 7, ingredients: [], policyCategories: [], allergenEvidence: {},
    checkedAllergens: [], ingredientsText: null, ingredientsTextIsLabel: false,
    per100g: { energy_kcal: { amount: 200 }, protein: { amount: 25 },
      carbohydrate: { amount: 0 }, fat_total: { amount: 10 } },
    kcalPer100g: 200, simplePer100g: { kcal: 200, protein: 25, carbs: 0, fat: 10 },
    portions: [], servingPortions: [{ id: null, label: "100 g", grams: 100, kcal: 200 }],
    defaultPortion: null,
  }),
}));
vi.mock("@/lib/coach/suggest-policy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/suggest-policy")>(),
  loadSuggestionEvidence: evidenceMock,
}));

const PORK_REF = "3f1b1a2c-0000-4000-8000-000000000011";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000010";
const NOW = new Date("2026-09-19T16:00:00.000Z").getTime();
type Row = Record<string, unknown>;

function db(tables: Record<string, Row[]> = {}) {
  const api = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((pick) => pick(row)));
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push((row) => !(column in row) || row[column] === value);
        return chain;
      },
      neq: () => chain, lte: () => chain, gte: () => chain, in: () => chain, is: () => chain,
      order: () => chain, limit: () => chain, insert: () => chain, update: () => chain,
      ilike: () => chain,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    });
    return chain;
  };
  return { from: (table: string) => api(table), rpc: async () => ({ data: PORK_REF, error: null }) } as never;
}

const porkEvidence: SuggestionEvidence = {
  status: "ready",
  preferenceFlags: [],
  byIdentity: {
    [`ref:${PORK_REF}`]: {
      allergenTags: [], policyCategories: [], noCook: null, onEatsList: true,
      onAvoidList: false, role: "protein", foodName: "Pork chop",
      facets: { pork: { p: 0.99 }, human_food: { p: 0.99 } } as never,
    },
  },
};

function rule(facet: string, hardBasis: string, confirmation: string, profileId: string) {
  return {
    id: `${profileId}:${facet}`, profileId, facet, strength: "never", hardBasis,
    evidenceStrength: null, confirmation, expiresAt: null,
  };
}

function storedProfile(profileId: string, rules: Row[]): Row {
  return {
    user_id: "u1", profile_id: profileId, source: "user_stated",
    confirmed_at: "2026-09-18T00:00:00.000Z", rules, options: {}, notes: null,
  };
}

const suggestIntent = {
  intent: "suggest_options", confidence: 0.97,
  args: { kind: "meal", count: 1 }, argConfidence: {}, raw: {} as never,
} as unknown as IntentResult;

async function suggestFor(tables: Record<string, Row[]>) {
  const client = db(tables);
  return runTurn(client, client, "u1", {
    threadId: null, messageId: MESSAGE, text: "suggest a meal",
    now: "2026-09-19T10:00:00-06:00", tz: "America/Denver",
  }, {
    classifyIntent: vi.fn().mockResolvedValue(suggestIntent) as never,
    generate: vi.fn(() => { throw new Error("the fast path must not call the model"); }) as never,
    now: () => NOW,
    newId: () => "id-1",
  });
}

const suggestedNames = (result: Awaited<ReturnType<typeof runTurn>>) =>
  (result.composed ?? []).flatMap((meal) => meal.items.map((item) => item.name));

describe("runTurn — confirmed profile hard rules reach the suggestion policy", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    evidenceMock.mockReset().mockResolvedValue(porkEvidence);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("suggests the pork chop to an account with no profile rules (control)", async () => {
    const result = await suggestFor({});
    expect(result.intent).toBe("suggest_options");
    expect(suggestedNames(result)).toContain("Pork chop");
  });

  it("blocks a pork suggestion under a confirmed religious 'pork' rule", async () => {
    const result = await suggestFor({ user_dietary_profiles: [
      storedProfile("halal", [rule("pork", "religious", "confirmed", "halal")]),
    ] });
    expect(suggestedNames(result)).not.toContain("Pork chop");
    // The rule's own facet is read from the cache with the rest (never a new model call).
    expect(evidenceMock).toHaveBeenCalledWith("u1", expect.any(Array),
      expect.objectContaining({ facets: expect.arrayContaining(["pork"]) }));
  });

  it("does not block under an UNCONFIRMED medical rule on the same facet", async () => {
    const result = await suggestFor({ user_dietary_profiles: [
      storedProfile("some_condition", [
        rule("pork", "user_confirmed_safety", "unconfirmed", "some_condition"),
      ]),
    ] });
    expect(suggestedNames(result)).toContain("Pork chop");
  });
});
