import { describe, expect, it } from "vitest";
import { detectFoodPreference } from "@/lib/coach/food-preference-detect";
import {
  buildFoodPreferenceRule, foodNamedFacet, FOOD_PREFERENCE_PROFILE_ID, normalizeFoodName,
} from "@/lib/policy/profiles/food-preference-rule";
import { profileFacetOutcome } from "@/lib/policy/profiles/hard-rules";
import { facetsForFood } from "@/lib/policy/profiles/rank-context";
import { rankFoods } from "@/lib/policy/profiles/rank-foods";
import { checkItem } from "@/lib/coach/policy";
import { isActiveHardRule, ruleId, type ProfileInstance, type RuleItem } from "@/lib/policy/profiles/types";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const NOW = new Date("2026-09-24T00:00:00.000Z");

describe("detectFoodPreference — detection", () => {
  it("reads a dislike, trimmed to the named food", () => {
    expect(detectFoodPreference("I hate cilantro, it ruins everything."))
      .toEqual({ foodName: "cilantro", strength: "avoid" });
  });

  it("reads a like", () => {
    expect(detectFoodPreference("I love salmon for dinner.")).toEqual({
      foodName: "salmon", strength: "prefer",
    });
  });

  it("reads 'don't like' and 'can't stand' as avoid, never as a like", () => {
    expect(detectFoodPreference("I don't like broccoli")).toEqual({
      foodName: "broccoli", strength: "avoid",
    });
    expect(detectFoodPreference("I can't stand mushrooms")).toEqual({
      foodName: "mushrooms", strength: "avoid",
    });
  });

  it("stops at a clause break so a second clause does not bleed into the name", () => {
    expect(detectFoodPreference("I hate cilantro but I love salmon")).toEqual({
      foodName: "cilantro", strength: "avoid",
    });
  });

  it("returns null for a message that states no preference at all", () => {
    expect(detectFoodPreference("What should I eat for lunch today?")).toBeNull();
  });
});

describe("buildFoodPreferenceRule — confirmation", () => {
  it("is always soft: strength prefer or avoid, hard basis always null", () => {
    const avoid = buildFoodPreferenceRule({
      foodName: "Cilantro", strength: "avoid", confirmedAt: NOW.toISOString(),
    });
    expect(avoid.strength).toBe("avoid");
    expect(avoid.hardBasis).toBeNull();
    expect(avoid.facet).toBe("food_named:cilantro");
    expect(avoid.profileId).toBe(FOOD_PREFERENCE_PROFILE_ID);
    expect(avoid.confirmation).toBe("unconfirmed");
  });

  it("normalizes the food name the same way the facet id and rank-context matcher expect", () => {
    expect(normalizeFoodName("  Cilantro  ")).toBe("cilantro");
    expect(foodNamedFacet("Cilantro")).toBe("food_named:cilantro");
  });

  it("a confirmed avoid rule never satisfies isActiveHardRule — structurally never a block", () => {
    const rule: RuleItem = {
      ...buildFoodPreferenceRule({ foodName: "cilantro", strength: "avoid", confirmedAt: NOW.toISOString() }),
      confirmation: "confirmed",
    };
    expect(isActiveHardRule(rule, NOW)).toBe(false);
  });
});

describe("food_named: facet resolution (lib/policy/profiles/hard-rules.ts)", () => {
  it("reads present only on a whole-word match of the food's own name", () => {
    expect(profileFacetOutcome("food_named:salmon", { foodName: "Grilled salmon fillet" }))
      .toBe("present");
    expect(profileFacetOutcome("food_named:salmon", { foodName: "Salmonella test kit" }))
      .toBe("unknown");
    expect(profileFacetOutcome("food_named:salmon", { foodName: "Chicken breast" }))
      .toBe("unknown");
  });

  it("also matches ingredient text, not only the food's own name", () => {
    expect(profileFacetOutcome("food_named:cilantro",
      { foodName: "Salsa verde", ingredientsText: "tomatillo, onion, cilantro, lime" }))
      .toBe("present");
  });
});

describe("rank effect — a like/dislike ranks, and only ranks", () => {
  function instance(rule: RuleItem): ProfileInstance {
    return {
      profileId: FOOD_PREFERENCE_PROFILE_ID, source: "user_stated",
      confirmedAt: NOW.toISOString(), rules: [rule], options: {},
    };
  }

  it("a confirmed dislike lowers a food's rank score when its facet reads present", () => {
    const avoid: RuleItem = {
      ...buildFoodPreferenceRule({ foodName: "cilantro", strength: "avoid", confirmedAt: NOW.toISOString() }),
      confirmation: "confirmed",
    };
    const facets = facetsForFood([instance(avoid)], { foodName: "Cilantro lime rice" });
    const result = rankFoods([instance(avoid)], facets);
    expect(result.score).toBeLessThan(0);
    expect(result.reasons).toEqual([
      { profileId: FOOD_PREFERENCE_PROFILE_ID, facet: "food_named:cilantro", strength: "avoid",
        weight: -5 },
    ]);
  });

  it("a confirmed like raises a food's rank score when its facet reads present", () => {
    const prefer: RuleItem = {
      ...buildFoodPreferenceRule({ foodName: "salmon", strength: "prefer", confirmedAt: NOW.toISOString() }),
      confirmation: "confirmed",
    };
    const facets = facetsForFood([instance(prefer)], { foodName: "Grilled salmon" });
    const result = rankFoods([instance(prefer)], facets);
    expect(result.score).toBeGreaterThan(0);
  });

  it("an unconfirmed preference never affects the score", () => {
    const avoid = buildFoodPreferenceRule({
      foodName: "cilantro", strength: "avoid", confirmedAt: NOW.toISOString(),
    }); // confirmation stays "unconfirmed"
    const facets = facetsForFood([instance(avoid)], { foodName: "Cilantro lime rice" });
    expect(rankFoods([instance(avoid)], facets)).toEqual({ score: 0, reasons: [] });
  });

  it("a dislike never produces a block, however strongly it scores", () => {
    const avoid: RuleItem = {
      ...buildFoodPreferenceRule({ foodName: "cilantro", strength: "avoid", confirmedAt: NOW.toISOString() }),
      confirmation: "confirmed",
    };
    const facets = facetsForFood([instance(avoid)], { foodName: "Cilantro lime rice" });
    const ranked = rankFoods([instance(avoid)], facets);
    expect(ranked.score).toBeLessThan(0); // it does rank the food down…

    // …but evaluatePolicy, given the very same profile rule set, has nothing that can block it:
    // isActiveHardRule filters it out before it could ever reach evaluatePolicy's `profileRules`.
    const verdict = checkItem({
      foodRefId: null, name: "Cilantro lime rice", grams: 200,
      allergenTags: [], category: [], onEatsList: true, onAvoidList: false,
    }, TEST_PROFILE);
    expect(verdict.verdict).not.toBe("blocked");
  });
});

describe("facetsForFood — rank-context glue", () => {
  it("resolves only the facets referenced by the given instances' rules", () => {
    const rule = ruleId(FOOD_PREFERENCE_PROFILE_ID, "food_named:salmon");
    const instance: ProfileInstance = {
      profileId: FOOD_PREFERENCE_PROFILE_ID, source: "user_stated", confirmedAt: NOW.toISOString(),
      options: {}, rules: [{
        id: rule, profileId: FOOD_PREFERENCE_PROFILE_ID, facet: "food_named:salmon",
        strength: "prefer", hardBasis: null, evidenceStrength: "user_rule",
        confirmation: "confirmed", expiresAt: null,
      }],
    };
    const facets = facetsForFood([instance], { foodName: "Grilled salmon" });
    expect(Object.keys(facets)).toEqual(["food_named:salmon"]);
    expect(facets["food_named:salmon"]).toBe("present");
  });
});
