/**
 * A ready policy-evidence port for plan-food tests (lib/coach/plan-item-policy.ts): each food is
 * read as a clean, tag-checked catalog row named as grounded and already judged human food, plus
 * any per-name overrides and the account's diet flags. No database.
 */
import { vi } from "vitest";
import type { PlanEvidencePort } from "@/lib/coach/plan-item-policy";
import type { SuggestionFoodEvidence } from "@/lib/coach/suggest-policy";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";

const HUMAN_FOOD: SuggestionFoodEvidence["facets"] = {
  human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-10-01T00:00:00.000Z" },
};

export function readyPlanEvidence(
  preferenceFlags: PolicyPreferenceFlag[] = [],
  byName: Record<string, Partial<SuggestionFoodEvidence>> = {},
) {
  return vi.fn<PlanEvidencePort>(async (_userId, foods) => ({
    status: "ready", preferenceFlags,
    byIdentity: Object.fromEntries(foods.map((food) => {
      const name = (food as { name?: string }).name ?? "";
      return [`ref:${food.foodRefId}`, {
        allergenTags: [], allergenEvidence: {}, checkedAllergens: [], ingredientsText: null,
        foodName: name, foodBrand: null, policyCategories: [], facets: HUMAN_FOOD, noCook: null,
        onEatsList: false, onAvoidList: false, role: null, ...byName[name.toLowerCase()],
      } satisfies SuggestionFoodEvidence];
    })),
  }));
}
