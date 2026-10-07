import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { activeConfirmedHardMarks, profileFacetOutcome } from "@/lib/policy/profiles/hard-rules";
import { ruleId, type RuleItem } from "@/lib/policy/profiles/types";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const AS_OF = new Date("2026-09-24T12:00:00Z");

/** A confirmed, unexpired hard item unless `overrides` says otherwise. */
function item(facet: string, profileId: string, overrides: Partial<RuleItem> = {}): RuleItem {
  return {
    id: ruleId(profileId, facet), profileId, facet, strength: "never",
    hardBasis: "user_confirmed_safety", evidenceStrength: "strong", confirmation: "confirmed",
    expiresAt: null, ...overrides,
  };
}
const rules = (...items: RuleItem[]) => ({ items, asOf: AS_OF });

const baseEvidence = {
  foodRefId: null, allergenTags: [], category: [], onEatsList: false, onAvoidList: false,
};

describe("profileFacetOutcome (§4, §9 R5)", () => {
  it("resolves a frozen Facet from deterministic evidence only, never a Jev judgment (W2c)", () => {
    expect(profileFacetOutcome("pork", { ingredientsText: null })).toBe("unknown");
    expect(profileFacetOutcome("pork", { foodName: "Pork chop", ingredientsText: null })).toBe("present");
    expect(profileFacetOutcome("pork", { foodName: "Banana", ingredientsText: null })).toBe("absent");
  });

  it("resolves a NEW_FACETS id deterministically from ingredient text, never guessing absent", () => {
    expect(profileFacetOutcome("red_meat", { ingredientsText: "beef, salt, water" })).toBe("present");
    expect(profileFacetOutcome("red_meat", { ingredientsText: "chicken, salt" })).toBe("unknown");
  });

  it("gives NEW_FACETS the food name and nutrients, not only the ingredient text (sol FIX)", () => {
    expect(profileFacetOutcome("high_mercury_fish", { foodName: "Swordfish steak", ingredientsText: null }))
      .toBe("present");
    expect(profileFacetOutcome("high_sodium", { nutrientsPerServing: { sodium: 900 } })).toBe("present");
    expect(profileFacetOutcome("high_sodium", { nutrientsPerServing: { sodium: 20 } })).toBe("absent");
    expect(profileFacetOutcome("protein_dense", {
      nutrientsPerServing: { protein: 25, energy_kcal: 120 },
    })).toBe("present");
  });

  it("a confirmed hard rule on a nutrient facet blocks through evaluatePolicy", () => {
    const result = evaluatePolicy(TEST_PROFILE_NO_ALLERGENS, {
      ...baseEvidence, nutrientsPerServing: { sodium: 1200 },
      profileRules: rules(item("high_sodium", "user_never_salty", { hardBasis: "user_rule" })),
    });
    expect(result.verdict).toBe("blocked");
  });

  it("resolves an account-named allergen template deterministically, never guessing absent", () => {
    expect(profileFacetOutcome("contains_allergen:mustard", { ingredientsText: "mustard seed, oil" }))
      .toBe("present");
    expect(profileFacetOutcome("contains_allergen:mustard", { ingredientsText: "oil, salt" }))
      .toBe("unknown");
  });

  it("leaves an unimplemented contains_ingredient: template unknown, not guessed", () => {
    expect(profileFacetOutcome("contains_ingredient:vinegar", { ingredientsText: "vinegar, salt" }))
      .toBe("unknown");
  });
});

describe("evaluatePolicy with confirmed profile hard rules (§4, §9 R5) — blocked/unverified/allowed", () => {
  it.each([
    {
      name: "a confirmed user_rule 'never' blocks when its facet is present",
      profileRules: rules(item("pork", "user_never_pork", { hardBasis: "user_rule" })),
      evidence: { ingredientsText: "pork, water, salt" },
      verdict: "blocked",
    },
    {
      name: "the same rule is unverified when its facet has no evidence yet",
      profileRules: rules(item("pork", "user_never_pork", { hardBasis: "user_rule" })),
      evidence: {},
      verdict: "unverified",
    },
    {
      name: "the same rule allows the food once deterministic evidence rules it out",
      profileRules: rules(item("pork", "user_never_pork", { hardBasis: "user_rule" })),
      evidence: { foodName: "Broccoli, steamed" },
      verdict: "allowed",
    },
    {
      name: "W2c: a Jev 'absent' alone no longer clears the rule",
      profileRules: rules(item("pork", "user_never_pork", { hardBasis: "user_rule" })),
      evidence: { facets: { pork: { p: 0.01, rubricVersion: 1, judgedAt: "" } }, facetAction: "exclude" as const },
      verdict: "unverified",
    },
    {
      name: "W2c: a Jev 'present' alone no longer blocks; the food is unverified, never allowed",
      profileRules: rules(item("pork", "user_never_pork", { hardBasis: "user_rule" })),
      evidence: { facets: { pork: { p: 0.99, rubricVersion: 1, judgedAt: "" } }, facetAction: "exclude" as const },
      verdict: "unverified",
    },
    {
      name: "a religious hard rule (halal, pork) blocks on a deterministic name match",
      profileRules: rules(item("pork", "halal", { hardBasis: "religious" })),
      evidence: { foodName: "Bacon, cooked" },
      verdict: "blocked",
    },
    {
      name: "a user_confirmed_safety medical rule using the allergen template blocks on ingredient text",
      profileRules: rules(item("contains_allergen:tyramine", "user_confirmed_safety_example")),
      evidence: { ingredientsText: "aged cheddar tyramine-rich" },
      verdict: "blocked",
    },
    {
      name: "the same medical rule is unverified with no ingredient text at all",
      profileRules: rules(item("contains_allergen:tyramine", "user_confirmed_safety_example")),
      evidence: { ingredientsText: null },
      verdict: "unverified",
    },
    {
      name: "no active profile rules at all: allowed (nothing else restricts)",
      profileRules: rules(),
      evidence: {},
      verdict: "allowed",
    },
  ])("$name", ({ profileRules, evidence, verdict }) => {
    const result = evaluatePolicy(TEST_PROFILE_NO_ALLERGENS, { ...baseEvidence, ...evidence, profileRules });
    expect(result.verdict).toBe(verdict);
  });

  it.each([
    { name: "an unconfirmed medical item", over: { confirmation: "unconfirmed" } },
    { name: "a declined medical item", over: { confirmation: "declined" } },
    { name: "an expired medical item", over: { expiresAt: "2026-09-01T00:00:00Z" } },
    { name: "a diagnosis-only item with no permitted hard basis", over: { hardBasis: null } },
    { name: "a soft 'limit' item", over: { strength: "limit" } },
    { name: "a calendar item outside the user's dates", over: {
      window: "calendar", activeWindows: [{ start: "2026-03-06T00:00:00Z", end: "2026-03-07T00:00:00Z" }],
    } },
  ] as { name: string; over: Partial<RuleItem> }[])(
    "evaluatePolicy itself drops $name passed in profileRules — it never blocks",
    ({ over }) => {
      const evidence = { ...baseEvidence, ingredientsText: "aged cheddar tyramine-rich" };
      const confirmed = evaluatePolicy(TEST_PROFILE_NO_ALLERGENS, {
        ...evidence, profileRules: rules(item("contains_allergen:tyramine", "maoi")),
      });
      expect(confirmed.verdict).toBe("blocked"); // the same item, confirmed, does block
      const result = evaluatePolicy(TEST_PROFILE_NO_ALLERGENS, {
        ...evidence, profileRules: rules(item("contains_allergen:tyramine", "maoi", over)),
      });
      expect(result.verdict).toBe("allowed");
      expect(result.marks ?? []).not.toContainEqual(expect.objectContaining({ source: "profile" }));
    },
  );

  it("does not disturb the allergen floor's precedence: an allergen finding still outranks a profile rule", () => {
    const result = evaluatePolicy(TEST_PROFILE, {
      ...baseEvidence,
      allergenTags: null,
      profileRules: rules(item("pork", "user_never_pork", { hardBasis: "user_rule" })),
    });
    // TEST_PROFILE avoids gluten/dairy/apple; allergenTags null -> no_evidence for those ->
    // unverified from the allergen floor, same as with no profile rules at all.
    expect(result.verdict).toBe("unverified");
    expect(result.allergens?.length).toBeGreaterThan(0);
  });

  it("computes activeConfirmedHardMarks directly: drops an absent outcome, keeps present/unknown", () => {
    const marks = activeConfirmedHardMarks(
      rules(item("pork", "a"), item("beef", "b"), item("alcohol", "c")),
      { foodName: "Pork chop" },
    );
    // A plain pork chop: pork present; beef and alcohol ruled out by its class, so no mark.
    expect(marks).toEqual([{ facet: "pork", source: "profile", outcome: "present" }]);
  });
});

const TEST_PROFILE_NO_ALLERGENS = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] };
