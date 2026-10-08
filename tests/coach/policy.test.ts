import { describe, expect, it } from "vitest";
import { allergenFacts, checkDraft, checkItem, checkItemWithMarks } from "@/lib/coach/policy";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

// 2026-10-02: the placeholder name must not itself be a recognized plain whole food (owner
// decision, lib/policy/whole-foods.ts) — these cases are testing the generic no-evidence/no-name
// path, not whole-food clearance, and "mystery bar" already carries no clearance ("bar" excludes
// it), the same placeholder checkDraft's own no-evidence case below already uses.
const item = (over: Partial<Parameters<typeof checkItem>[0]> = {}) => ({
  foodRefId: null, name: "mystery bar", grams: 150,
  allergenTags: [] as string[] | null, category: null as string[] | null,
  onEatsList: true, onAvoidList: false, ...over,
});

describe("checkItem", () => {
  it("blocks a dairy food and names the allergen", () => {
    expect(checkItem(item({ name: "yoghurt", allergenTags: ["dairy"] }), DEFAULT_PROFILE))
      .toEqual({ verdict: "blocked", reason: "allergen:dairy" });
  });

  it("marks a food with no ingredient evidence and no Eats entry unverified", () => {
    expect(checkItem(item({ allergenTags: null, onEatsList: false }), DEFAULT_PROFILE))
      .toEqual({ verdict: "unverified" });
  });

  it("allows a clean food on her Eats list once its label is checked (Phase 13 §5)", () => {
    expect(checkItem(item({ checkedAllergens: ["gluten", "dairy", "apple"] }), DEFAULT_PROFILE))
      .toEqual({ verdict: "allowed" });
  });

  it("the Eats list alone no longer clears an active allergen: unverified", () => {
    expect(checkItem(item(), DEFAULT_PROFILE)).toEqual({ verdict: "unverified" });
  });

  it("blocks a banned category and an avoided ref", () => {
    expect(checkItem(item({ category: ["simple_sugars"] }), DEFAULT_PROFILE).verdict).toBe("blocked");
    const ref = "3f1b1a2c-0000-4000-8000-000000000009";
    expect(checkItem(item({ foodRefId: ref }),
      { ...DEFAULT_PROFILE, avoid_food_ref_ids: [ref] }).verdict).toBe("blocked");
  });

  it("r4 BLOCK #8 follow-up: stays unverified for 'Canned tuna' on a pregnancy profile even " +
    "with clean ingredients and no tuna tag — checkItem is where every coach path (checkDraft, " +
    "reply-check, the suggestion filter) converges, so the item's own name must reach it", () => {
    const pregnant = { ...DEFAULT_PROFILE, avoid_allergens: [], conditions: ["pregnant"] };
    expect(checkItem(item({ name: "Canned tuna", allergenTags: [] }), pregnant).verdict)
      .toBe("unverified");
  });

  // 2026-10-02 DeepSeek audit (F2, MED): `packaged` must reach evaluatePolicy the same way
  // `foodBrand` already does — PolicyItem had no such field at all, so a packaged, unbranded
  // product (a store-label scan with a blank brand string) could still clear through
  // lib/policy/whole-foods.ts's whole-food reading of its plain-sounding name.
  it("a packaged item never gets whole-food clearance, even with no brand string", () => {
    const dairyOnly = { ...DEFAULT_PROFILE, avoid_allergens: ["dairy"] };
    expect(checkItem(item({ name: "Chicken breast", allergenTags: null, foodBrand: null }),
      dairyOnly).verdict).toBe("allowed");
    expect(checkItem(item({ name: "Chicken breast", allergenTags: null, foodBrand: null,
      packaged: true }), dairyOnly).verdict).toBe("unverified");
  });
});

describe("allergenFacts", () => {
  it("picks up a hit's brand (FoodHit shape) as foodBrand, and carries packaged through", () => {
    expect(allergenFacts({ brand: "Acme", packaged: true })).toMatchObject(
      { foodBrand: "Acme", packaged: true });
  });

  it("prefers an already-PolicyItem-shaped foodBrand over a FoodHit's brand", () => {
    expect(allergenFacts({ foodBrand: "Acme", brand: "Other" }))
      .toMatchObject({ foodBrand: "Acme" });
  });

  it("is null-safe and defaults foodBrand to null, packaged to undefined", () => {
    expect(allergenFacts(undefined)).toMatchObject({ foodBrand: null, packaged: undefined });
  });
});

/* sol FIX (t2b review): the marks behind an unverified verdict reach the coach card. */
describe("checkItemWithMarks", () => {
  it("keeps checkItem's verdict and adds the gap behind an unverified one", () => {
    const gap = checkItemWithMarks(item({ allergenTags: null, onEatsList: false }), DEFAULT_PROFILE);
    expect(gap.verdict).toBe("unverified");
    expect("marks" in gap && gap.marks).toContainEqual(
      { facet: "gluten", source: "floor", outcome: "unknown" });
    const pregnant = { ...DEFAULT_PROFILE, avoid_allergens: [], conditions: ["pregnant"] };
    expect(checkItemWithMarks(item({ name: "Canned tuna" }), pregnant)).toEqual({
      verdict: "unverified", marks: [{ facet: "tuna_mercury", source: "floor", outcome: "unknown" }] });
    expect(checkItemWithMarks(item({ checkedAllergens: ["gluten", "dairy", "apple"] }),
      DEFAULT_PROFILE)).toEqual({ verdict: "allowed" });
  });
});

describe("checkDraft", () => {
  it("returns one suggestion per draft item, carrying the verdict and grams", () => {
    const suggestions = checkDraft(
      { draftId: "d1", slot: "meal-2", items: [
        { foodRefId: "3f1b1a2c-0000-4000-8000-000000000001", name: "rice", grams: 150,
          catalogFoodRevisionId: 11 },
        { foodRefId: "3f1b1a2c-0000-4000-8000-000000000002", name: "yoghurt", grams: 120,
          catalogFoodRevisionId: 12 },
      ] },
      DEFAULT_PROFILE,
      {
        rice: { foodRefId: "3f1b1a2c-0000-4000-8000-000000000001", allergenTags: [],
          category: null, onEatsList: true, onAvoidList: false,
          checkedAllergens: ["gluten", "dairy", "apple"] },
        yoghurt: { foodRefId: "3f1b1a2c-0000-4000-8000-000000000002", allergenTags: ["dairy"],
          category: null, onEatsList: false, onAvoidList: false },
      },
    );
    expect(suggestions.map((s) => s.verdict)).toEqual(["allowed", "blocked"]);
    expect(suggestions[1].reason).toBe("allergen:dairy");
    expect(suggestions[0].grams).toBe(150);
  });

  it("treats an item with no evidence as unverified, never allowed", () => {
    const suggestions = checkDraft(
      { draftId: "d1", slot: "meal-1",
        items: [{ foodRefId: "3f1b1a2c-0000-4000-8000-000000000003", name: "mystery bar",
          grams: 50, catalogFoodRevisionId: null }] },
      DEFAULT_PROFILE,
    );
    expect(suggestions[0].verdict).toBe("unverified");
  });
});

describe("checkItem with the server-read profile of an account with no allergen rule and no condition", () => {
  // lib/server/constraints.ts always reads `conditions`; an account with no rules reads [].
  const NO_RULES = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [] };

  it("a catalog food off Eats with no tag list is allowed, not unverified (no allow list)", () => {
    expect(checkItem(item({ allergenTags: null, onEatsList: false }), NO_RULES)).toEqual({ verdict: "allowed" });
  });

  it("the same food stays unverified for an account with an allergen rule, and Avoid blocks it", () => {
    expect(checkItem(item({ allergenTags: null, onEatsList: false }), { ...NO_RULES, avoid_allergens: ["soy"] }))
      .toEqual({ verdict: "unverified" });
    expect(checkItem(item({ allergenTags: null, onEatsList: false, onAvoidList: true }), NO_RULES).verdict)
      .toBe("blocked");
  });
});
