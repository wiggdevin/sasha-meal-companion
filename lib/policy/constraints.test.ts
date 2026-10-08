import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE,
  evaluatePolicy,
  loadProfile,
  type ConstraintProfile,
  type PolicyEvidence,
} from "./constraints";
/**
 * D1 §6.1 removed the code default that used to be `DEFAULT_PROFILE`. The evaluator cases below
 * still need a profile that avoids things, so they take the same values from an explicit test
 * fixture; `tests/constraints/neutral-defaults.test.ts` is where the new empty default is pinned.
 */
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

function evidence(overrides: Partial<PolicyEvidence> = {}): PolicyEvidence {
  return {
    foodRefId: null, allergenTags: [], category: null,
    onEatsList: false, onAvoidList: false, ...overrides,
  };
}

/**
 * Evidence that clears every allergen TEST_PROFILE avoids (Phase 13 §5): dairy is one of the nine
 * and a complete label lists none; gluten and apple are not, so the user checked this product.
 */
const CLEARED: Partial<PolicyEvidence> = {
  allergenEvidence: { dairy: { level: "not_listed", labelComplete: true } },
  checkedAllergens: ["gluten", "apple"],
};

describe("EMPTY_PROFILE", () => {
  it("restricts nothing, because no account's rules live in code", () => {
    expect(EMPTY_PROFILE).toEqual({
      avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
    });
  });
});

describe("loadProfile", () => {
  it("returns EMPTY_PROFILE for a null row", () => {
    expect(loadProfile(null)).toEqual(EMPTY_PROFILE);
  });

  it("fills missing arrays on a partial row empty", () => {
    const result = loadProfile({ avoid_allergens: ["gluten"] });
    expect(result).toEqual({
      avoid_allergens: ["gluten"], avoid_food_ref_ids: [], banned_categories: [], conditions: [],
    });
  });

  it("passes through a fully specified row unchanged, conditions included", () => {
    const row: ConstraintProfile = {
      avoid_allergens: ["shellfish"],
      avoid_food_ref_ids: ["11111111-1111-1111-1111-111111111111"],
      banned_categories: ["fried"],
      conditions: ["pregnant"],
    };
    expect(loadProfile(row)).toEqual(row);
  });
});

describe("evaluatePolicy", () => {
  it("blocks on an allergen match, case-insensitively, reason allergen:<tag>", () => {
    const verdict = evaluatePolicy(DEFAULT_PROFILE, evidence({ allergenTags: ["Gluten"] }));
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "allergen:gluten" });
  });

  it("blocks when foodRefId is on the avoid list, reason avoid_list", () => {
    const profile: ConstraintProfile = { ...DEFAULT_PROFILE, avoid_food_ref_ids: ["abc-123"] };
    const verdict = evaluatePolicy(profile, evidence({ foodRefId: "abc-123", allergenTags: [] }));
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("blocks on a banned category, case-insensitively, reason category:<c>", () => {
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: [], category: ["Simple_Sugars"] }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "category:Simple_Sugars" });
  });

  it("is unverified when allergenTags is null and not on the eats list", () => {
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: null, onEatsList: false }),
    );
    expect(verdict.verdict).toBe("unverified");
  });

  it("the Eats list no longer clears an active allergen (Phase 13 §5)", () => {
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: null, onEatsList: true }),
    );
    expect(verdict.verdict).toBe("unverified");
  });

  it("with no allergen rule, the Eats list still clears missing evidence as before", () => {
    const verdict = evaluatePolicy(
      { ...DEFAULT_PROFILE, avoid_allergens: [] },
      evidence({ allergenTags: null, onEatsList: true }),
    );
    expect(verdict).toEqual({ verdict: "allowed" });
  });

  it("a legacy empty tag list is not evidence: unverified, 'Check the label' (§9 R2)", () => {
    const verdict = evaluatePolicy(DEFAULT_PROFILE, evidence({ allergenTags: [] }));
    expect(verdict.verdict).toBe("unverified");
    expect(verdict.allergens?.map((finding) => finding.text)).toEqual([
      "Check the label for gluten", "Check the label for dairy", "Check the label for apple",
    ]);
  });

  it("a blocked verdict wins over unverified", () => {
    const profile: ConstraintProfile = { ...DEFAULT_PROFILE, avoid_food_ref_ids: ["abc-123"] };
    const verdict = evaluatePolicy(
      profile,
      evidence({ foodRefId: "abc-123", allergenTags: null, onEatsList: false }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("is allowed when nothing matches and every avoided allergen is cleared", () => {
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: ["peanut"], category: ["protein"], ...CLEARED }),
    );
    expect(verdict).toMatchObject({ verdict: "allowed" });
    expect(verdict.allergens?.map((finding) => finding.text)).toEqual([
      "You checked this label for gluten", "No dairy listed on the label",
      "You checked this label for apple",
    ]);
  });

  it("blocks when the food is on her avoid list, reason avoid_list", () => {
    const verdict = evaluatePolicy(DEFAULT_PROFILE, evidence({ onAvoidList: true }));
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("an allergen outranks the avoid list", () => {
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: ["gluten"], onAvoidList: true }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "allergen:gluten" });
  });

  it("the avoid list outranks a banned category", () => {
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: [], category: ["simple_sugars"], onAvoidList: true }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("avoid_food_ref_ids still outranks the avoid list, and both read avoid_list", () => {
    const profile: ConstraintProfile = { ...DEFAULT_PROFILE, avoid_food_ref_ids: ["abc-123"] };
    const verdict = evaluatePolicy(
      profile,
      evidence({ foodRefId: "abc-123", allergenTags: [], onAvoidList: true }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("onAvoidList never turns unverified into allowed — it blocks instead", () => {
    // The avoid branch runs BEFORE the unverified check, so a food with no ingredient evidence
    // that she has marked Avoid is blocked, never quietly upgraded.
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: null, onEatsList: false, onAvoidList: true }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("blocks on any element of the category array, naming the one that matched", () => {
    const verdict = evaluatePolicy(
      DEFAULT_PROFILE,
      evidence({ allergenTags: [], category: ["onion_garlic", "beans"] }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("an empty category array is evidence of no banned category, not a block", () => {
    const verdict = evaluatePolicy(DEFAULT_PROFILE,
      evidence({ allergenTags: [], category: [], ...CLEARED }));
    expect(verdict).toMatchObject({ verdict: "allowed" });
  });

  it("a switched-off category stops blocking", () => {
    const profile: ConstraintProfile = { ...DEFAULT_PROFILE, banned_categories: ["beans"] };
    const verdict = evaluatePolicy(
      profile,
      evidence({ allergenTags: [], category: ["onion_garlic"], ...CLEARED }),
    );
    expect(verdict).toMatchObject({ verdict: "allowed" });
  });
});

/** Phase 13 §9 R1: "Unspecified tuna is unverified for the pregnancy profile." */
describe("evaluatePolicy: pregnancy/tuna (§9 R1)", () => {
  // EMPTY_PROFILE avoids nothing, so this isolates the tuna check from allergen findings.
  const pregnant: ConstraintProfile = { ...EMPTY_PROFILE, conditions: ["pregnant"] };

  it("is unverified for unspecified tuna on a pregnancy profile, even with no allergy at all", () => {
    const verdict = evaluatePolicy(pregnant,
      evidence({ allergenTags: [], ingredientsText: "Tuna, water, salt" }));
    expect(verdict.verdict).toBe("unverified");
    expect(verdict.allergens).toMatchObject([{ allergen: "tuna_mercury", outcome: "unknown" }]);
  });

  it("stays allowed once the species is specified", () => {
    const verdict = evaluatePolicy(pregnant,
      evidence({ allergenTags: [], ingredientsText: "Skipjack tuna, water, salt" }));
    expect(verdict.verdict).toBe("allowed");
    expect(verdict.allergens ?? []).toEqual([]);
  });

  it("does not apply without the pregnancy condition", () => {
    const verdict = evaluatePolicy(EMPTY_PROFILE,
      evidence({ allergenTags: [], ingredientsText: "Tuna, water, salt" }));
    expect(verdict.verdict).toBe("allowed");
    expect(verdict.allergens ?? []).toEqual([]);
  });

  it("never blocks by itself — it only ever reads unverified", () => {
    const verdict = evaluatePolicy(pregnant,
      evidence({ allergenTags: [], ingredientsText: "Tuna, water, salt" }));
    expect(verdict.verdict).not.toBe("blocked");
  });
});

describe("evaluatePolicy: no allow list for an account with no allergen rule and no condition (2026-10-08)", () => {
  /** A server-read profile (lib/server/constraints.ts): `conditions` was selected and is empty. */
  const NO_RULES: ConstraintProfile = { ...EMPTY_PROFILE, conditions: [] };
  /** A catalog food with no allergen tag list, not on Eats: the case the legacy gate used to refuse. */
  const catalogFood = evidence({ foodRefId: "cat-1", allergenTags: null, category: [], onEatsList: false });

  it("a no-rules account gets a catalog food as allowed, Eats mark or not", () => {
    expect(evaluatePolicy(NO_RULES, catalogFood)).toEqual({ verdict: "allowed" });
    expect(evaluatePolicy(NO_RULES, { ...catalogFood, preferenceFlags: [] }).verdict).toBe("allowed");
  });

  it("an account with an allergen rule still gets unverified", () => {
    expect(evaluatePolicy({ ...NO_RULES, avoid_allergens: ["peanut"] }, catalogFood).verdict).toBe("unverified");
  });

  it("an account with a stated condition keeps the gate: unverified", () => {
    expect(evaluatePolicy({ ...NO_RULES, conditions: ["celiac"] }, catalogFood).verdict).toBe("unverified");
  });

  it("a profile whose conditions were never read keeps the gate (fail closed)", () => {
    expect(evaluatePolicy(EMPTY_PROFILE, catalogFood).verdict).toBe("unverified");
  });

  it("Avoid still blocks: the account's Avoid mark and an avoided food ref", () => {
    expect(evaluatePolicy(NO_RULES, { ...catalogFood, onAvoidList: true }))
      .toMatchObject({ verdict: "blocked", reason: "avoid_list" });
    expect(evaluatePolicy({ ...NO_RULES, avoid_food_ref_ids: ["cat-1"] }, catalogFood))
      .toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("diet and category rules still decide: a banned category blocks, an unknown diet facet stays unverified", () => {
    expect(evaluatePolicy({ ...NO_RULES, banned_categories: ["beans"] }, { ...catalogFood, category: ["beans"] }).verdict)
      .toBe("blocked");
    expect(evaluatePolicy(NO_RULES, { ...catalogFood, foodName: "Mystery stew", preferenceFlags: ["vegan"] }).verdict)
      .not.toBe("allowed");
  });
});
