import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";

const mocks = vi.hoisted(() => ({
  evidence: vi.fn(), profile: vi.fn(), review: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/policy-profile", () => ({ readPolicyProfile: mocks.profile }));
vi.mock("@/lib/server/constraints", () => ({ getRuleReviewStatus: mocks.review }));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: mocks.evidence,
}));

import { eligibleFoods } from "./eligible-foods";

function client(tables: Record<string, { data: unknown; error: unknown }>): SupabaseClient {
  return { from: (table: string) => {
    const result = tables[table] ?? { data: [], error: null };
    const query = {
      eq: () => query, in: () => query, order: () => query, range: () => query,
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return { select: () => query };
  } } as unknown as SupabaseClient;
}

const own = { id: "own", kind: "user", catalog_food_id: null, user_food_id: "food-own",
  user_foods: { id: "food-own", user_id: "account", name: "Peanut butter" } };
const other = { id: "other", kind: "user", catalog_food_id: null, user_food_id: "food-other",
  user_foods: { id: "food-other", user_id: "another-account", name: "Someone else's secret" } };
const catalog = { id: "catalog", kind: "catalog", catalog_food_id: 42,
  user_food_id: null, user_foods: null };
const prefs = [own, other, catalog].map((ref) => ({ food_ref_id: ref.id, status: "eats" }));
const facts = (allowed: boolean) => ({
  allergenTags: [], checkedAllergens: [], ingredientsText: null,
  policyCategories: [], facets: { human_food: {
    p: allowed ? 1 : 0, rubricVersion: 1, judgedAt: "2026-09-27",
  } }, noCook: null, onEatsList: true, onAvoidList: false, role: "protein",
});

beforeEach(() => {
  mocks.profile.mockReset(); mocks.evidence.mockReset(); mocks.review.mockReset();
  mocks.profile.mockResolvedValue({ profile: EMPTY_PROFILE, rev: 1, instances: [] });
  mocks.review.mockResolvedValue({ required: false, candidateAllergens: [],
    candidateCategories: [], rev: 1 });
});

describe("server food eligibility", () => {
  it("returns only account-owned refs with active revisions and allowed evidence", async () => {
    mocks.evidence.mockResolvedValue({ status: "ready", preferenceFlags: [],
      byIdentity: { "ref:own": facts(true), "ref:catalog": facts(false) } });
    const result = await eligibleFoods(client({
      user_food_prefs: { data: prefs, error: null },
      food_refs: { data: [own, other, catalog], error: null },
      catalog_food_revisions: { data: [{ id: 7, catalog_food_id: 42, description: "Glue stick" }],
        error: null },
    }), "account");
    expect(result).toEqual({ eligibleRefIds: ["own"], eligibleFoodIds: ["food-own"],
      eligibleCatalogFoodIds: [], rulesRevision: 1, preferenceFlags: [], excluded: [
        // Another account's food name is never read into this account's answer.
        { refId: "other", verdict: "unknown",
          reason: "could not be checked against your food rules.", name: "This food",
          mark: { verdict: "unknown",
            reason: "This food could not be checked against your food rules." } },
        { refId: "catalog", verdict: "blocked", reason: "is not recognised as a food.",
          name: "Glue stick",
          mark: { verdict: "blocked", reason: "Glue stick is not recognised as a food." } },
      ] });
    expect(mocks.evidence.mock.calls[0][1]).toEqual([
      { foodRefId: "own", catalogFoodRevisionId: null, verdict: "allowed" },
      { foodRefId: "catalog", catalogFoodRevisionId: 7, verdict: "allowed" },
    ]);
  });

  it("fails closed when evidence is unavailable", async () => {
    mocks.evidence.mockResolvedValue({ status: "unavailable", preferenceFlags: [], byIdentity: {} });
    const result = await eligibleFoods(client({
      user_food_prefs: { data: [prefs[0]], error: null },
      food_refs: { data: [own], error: null },
    }), "account");
    expect(result.eligibleRefIds).toEqual([]);
    expect(result.excluded).toEqual([{ refId: "own", verdict: "unknown",
      reason: "could not be checked against your food rules right now.", name: "Peanut butter",
      mark: { verdict: "unknown",
        reason: "Peanut butter could not be checked against your food rules right now." } }]);
  });

  it("says why a current allergen rule excludes an Eats food saved before it (F1)", async () => {
    mocks.profile.mockResolvedValue({ profile: { ...EMPTY_PROFILE, avoid_allergens: ["peanut"] },
      rev: 3, instances: [] });
    mocks.evidence.mockResolvedValue({ status: "ready", preferenceFlags: [],
      byIdentity: { "ref:own": { ...facts(true), allergenTags: ["peanut"],
        foodName: "Peanut butter" } } });
    const result = await eligibleFoods(client({
      user_food_prefs: { data: [prefs[0]], error: null },
      food_refs: { data: [own], error: null },
    }), "account");
    expect(result.eligibleRefIds).toEqual([]);
    expect(result.rulesRevision).toBe(3);
    expect(result.excluded).toEqual([{ refId: "own", verdict: "blocked",
      reason: "has peanut, which your rules exclude.", name: "Peanut butter",
      mark: { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." } }]);
  });

  it("applies the account's latest blocked ref even when Eats still contains it", async () => {
    mocks.profile.mockResolvedValue({ profile: {
      ...EMPTY_PROFILE, avoid_food_ref_ids: ["own"],
    }, rev: 2, instances: [] });
    mocks.evidence.mockResolvedValue({ status: "ready", preferenceFlags: [],
      byIdentity: { "ref:own": facts(true) } });
    const result = await eligibleFoods(client({
      user_food_prefs: { data: [prefs[0]], error: null },
      food_refs: { data: [own], error: null },
    }), "account");
    expect(result.eligibleRefIds).toEqual([]);
  });

  it("requires server-side historical rule review before reading Eats", async () => {
    mocks.review.mockResolvedValue({ required: true, candidateAllergens: ["gluten"],
      candidateCategories: [], rev: 1 });
    const db = client({});
    const from = vi.spyOn(db, "from");
    await expect(eligibleFoods(db, "account")).rejects.toMatchObject({
      status: 409, code: "rule_review_required",
    });
    expect(from).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
  });
});
