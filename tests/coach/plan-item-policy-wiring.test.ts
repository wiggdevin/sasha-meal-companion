/**
 * W014 (audit 2026-10-10 A023): both coach action paths (fast path and final step) apply
 * lib/server/coach-role-advice.ts applyGroundedActionPolicies, which must run the full plan pass
 * before refusePlanBlocked — before W014 a vegetarian account's bacon dinner was kept.
 */
import { describe, expect, it, vi } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";

const mocks = vi.hoisted(() => ({ evidence: vi.fn() }));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: mocks.evidence,
}));

const { applyGroundedActionPolicies } = await import("@/lib/server/coach-role-advice");

const BACON = "00000000-0000-4000-8000-0000000000b1";

describe("applyGroundedActionPolicies", () => {
  it("refuses a set_slot_meal a vegetarian account's diet flag blocks", async () => {
    mocks.evidence.mockResolvedValue({
      status: "ready", preferenceFlags: ["vegetarian"], byIdentity: { [`ref:${BACON}`]: {
        allergenTags: [], foodName: "Pork bacon, cooked", policyCategories: [], facets: {},
        noCook: null, onEatsList: false, onAvoidList: false, role: null,
      } },
    });
    const action = {
      actionId: "a1", kind: "set_slot_meal", from: "2026-10-10", slot: "meal-3", title: "Dinner",
      flagged: [], items: [{ name: "bacon", grams: 60, foodRefId: BACON, catalogFoodRevisionId: 3,
        kcalPer100g: 500, proteinPer100g: 30, carbsPer100g: 1, fatPer100g: 40, verdict: "allowed" }],
    } as unknown as CoachAction;
    const out = await applyGroundedActionPolicies({} as never, "u1", [action], {
      avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [],
    });
    expect(out.actions).toEqual([]);
    expect(out.recipeRefusals).toEqual([expect.stringContaining("bacon")]);
    expect(mocks.evidence).toHaveBeenCalledWith("u1", [expect.objectContaining({ foodRefId: BACON })],
      expect.objectContaining({ needsNoCook: false }));
  });
});
