/**
 * W101: a food held for review on an allergen the account avoids reaches Today's rule mark (and the
 * swap and suggestion cards, which take the same `/api/foods/eligible` reason) in the shared held
 * words, never as a plain "cannot be checked".
 */
import { describe, expect, it } from "vitest";
import { suggestionItemsVerdict } from "@/lib/coach/suggest-verdict";
import { namedRuleMark } from "@/lib/foods/rule-reason";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";

const REF = "11111111-1111-4111-8111-111111111111";

function verdict(held: boolean) {
  return suggestionItemsVerdict([{ foodRefId: REF, catalogFoodRevisionId: null, verdict: "allowed" }], {
    status: "ready", preferenceFlags: [], byIdentity: {
      [`ref:${REF}`]: {
        allergenTags: null,
        allergenEvidence: { peanut: { level: "listed", labelComplete: false, ...(held ? { held: true as const } : {}) } },
        foodName: "Trail mix", policyCategories: [], facets: { human_food: { p: 0.99 } } as never,
        noCook: null, onEatsList: true, onAvoidList: false, role: null,
      },
    },
  }, { ...EMPTY_PROFILE, avoid_allergens: ["peanut"] }, false);
}

describe("a held allergen on Today's rule mark", () => {
  it("says the shared held line after the food's name", () => {
    const result = verdict(true);
    expect(result.outcome).toBe("unverified");
    expect(namedRuleMark("Trail mix", { verdict: "unknown", reason: result.reason! }).reason)
      .toBe("Trail mix needs review. Peanut: Not verified. Evidence under review.");
  });

  it("still blocks a deterministic listing", () => {
    expect(verdict(false).outcome).toBe("blocked");
  });
});
