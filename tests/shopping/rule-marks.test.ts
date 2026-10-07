import { describe, expect, it } from "vitest";
import type { SuggestionEvidence, SuggestionFoodEvidence } from "@/lib/coach/suggest-policy";
import { EMPTY_PROFILE, type ConstraintProfile } from "@/lib/policy/constraints";
import {
  evidenceKey, shoppingRuleMark, UNAVAILABLE_CONTEXT, withShoppingRuleMarks,
  type ShoppingRuleContext,
} from "@/lib/shopping/rule-marks";
import type { IngredientIdentity } from "@/lib/shopping/types";

const PB_REF = "00000000-0000-4000-8000-0000000000a1";
const RICE_REF = "00000000-0000-4000-8000-0000000000a2";

function facts(over: Partial<SuggestionFoodEvidence>): SuggestionFoodEvidence {
  return { allergenTags: [], allergenEvidence: {}, checkedAllergens: [], ingredientsText: null,
    foodName: null, foodBrand: null, packaged: false, policyCategories: [], facets: {},
    noCook: null, onEatsList: false, onAvoidList: false, role: null, ...over };
}
function ref(foodRefId: string): IngredientIdentity {
  return { foodRefId, catalogFoodRevisionId: 7, purchaseState: "as_purchased", variantKey: "default" };
}
function context(profile: Partial<ConstraintProfile>, over: {
  byIdentity?: SuggestionEvidence["byIdentity"]; avoidNames?: string[]; avoidRefIds?: string[];
  avoidFoodDbIds?: string[]; evidenceStatus?: SuggestionEvidence["status"];
} = {}): ShoppingRuleContext {
  return { profile: { ...EMPTY_PROFILE, ...profile },
    evidence: over.evidenceStatus === "unavailable" ? { status: "unavailable" }
      : { status: "ready", preferenceFlags: [], facts: new Map(Object.entries(over.byIdentity ?? {})
        .map(([key, value]) => [evidenceKey(key.replace(/^ref:/, ""), 7), value])) },
    avoid: { refIds: new Set(over.avoidRefIds ?? []), names: new Set(over.avoidNames ?? []),
      foodDbIds: new Set(over.avoidFoodDbIds ?? []) } };
}

const peanutAllergy = context({ avoid_allergens: ["peanut"] }, { byIdentity: {
  [`ref:${PB_REF}`]: facts({ allergenTags: ["peanut"], foodName: "Peanut butter, smooth" }),
  [`ref:${RICE_REF}`]: facts({ foodName: "Rice, white, long-grain, cooked",
    allergenEvidence: { peanut: { level: "not_listed", labelComplete: true } } }),
} });

describe("shopping rule marks (calc audit F4)", () => {
  it("marks an existing peanut-butter line blocked after a peanut allergy is added", () => {
    expect(shoppingRuleMark({ name: "Peanut butter", identity: ref(PB_REF) }, peanutAllergy))
      .toEqual({ verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." });
  });

  it("leaves a line the current rules clear unmarked", () => {
    expect(shoppingRuleMark({ name: "Rice", identity: ref(RICE_REF) }, peanutAllergy)).toBeNull();
  });

  it("marks a referenced food the rules cannot clear unknown", () => {
    const mark = shoppingRuleMark({ name: "Granola bar",
      identity: ref("00000000-0000-4000-8000-0000000000a3") }, peanutAllergy);
    expect(mark).toEqual({ verdict: "unknown",
      reason: "We couldn't check Granola bar against your food rules." });
  });

  it("marks a typed manual line by its own text", () => {
    expect(shoppingRuleMark({ name: "peanut butter", identity: null }, peanutAllergy))
      .toMatchObject({ verdict: "blocked" });
  });

  it("leaves non-food and unmatched manual text unmarked", () => {
    expect(shoppingRuleMark({ name: "paper towels", identity: null }, peanutAllergy)).toBeNull();
    expect(shoppingRuleMark({ name: "granola", identity: null }, peanutAllergy)).toBeNull();
  });

  it("marks a manual line that names an Avoid entry", () => {
    const avoids = context({}, { avoidNames: ["granola"] });
    expect(shoppingRuleMark({ name: "Granola", identity: null }, avoids))
      .toEqual({ verdict: "blocked", reason: "Granola is on your Avoid list." });
    expect(shoppingRuleMark({ name: "paper towels", identity: null }, avoids)).toBeNull();
  });

  it("marks a referenced line whose name is on Avoid even through another ref", () => {
    const avoids = context({}, { avoidNames: ["peanut butter"], byIdentity: {
      [`ref:${PB_REF}`]: facts({ foodName: "Peanut butter, smooth" }) } });
    expect(shoppingRuleMark({ name: "Peanut butter", identity: ref(PB_REF) }, avoids))
      .toMatchObject({ verdict: "blocked", reason: "Peanut butter is on your Avoid list." });
  });

  it("marks nothing for an account with no food rules", () => {
    const none = context({});
    expect(shoppingRuleMark({ name: "Peanut butter", identity: ref(PB_REF) }, none)).toBeNull();
    expect(shoppingRuleMark({ name: "peanut butter", identity: null }, none)).toBeNull();
  });

  it("marks every line unknown when the rules cannot be read (t18 r2)", () => {
    const unread = UNAVAILABLE_CONTEXT;
    expect(shoppingRuleMark({ name: "Rice", identity: ref(RICE_REF) }, unread))
      .toMatchObject({ verdict: "unknown" });
    expect(shoppingRuleMark({ name: "peanut butter", identity: null }, unread))
      .toMatchObject({ verdict: "unknown" });
    expect(shoppingRuleMark({ name: "paper towels", identity: null }, unread))
      .toMatchObject({ verdict: "unknown" });
  });

  it("marks a no-ref line unknown, never clear, when only the Avoid list or the profile failed " +
    "(t18 r2)", () => {
    // "Food aa-01499" sits on page 2 of an Avoid list whose read failed: it must not read clear.
    const ready = context({ avoid_allergens: ["peanut"] });
    expect(shoppingRuleMark({ name: "Food aa-01499", identity: null }, { ...ready, avoid: null }))
      .toMatchObject({ verdict: "unknown" });
    expect(shoppingRuleMark({ name: "Granola", identity: null }, { ...ready, profile: null }))
      .toMatchObject({ verdict: "unknown" });
    // Both read and nothing matches: clear.
    expect(shoppingRuleMark({ name: "Granola", identity: null }, ready)).toBeNull();
  });

  it("still judges typed lines by text when only the food evidence is missing", () => {
    const noEvidence = context({ avoid_allergens: ["peanut"] }, { evidenceStatus: "unavailable" });
    expect(shoppingRuleMark({ name: "Rice", identity: ref(RICE_REF) }, noEvidence))
      .toMatchObject({ verdict: "unknown" });
    expect(shoppingRuleMark({ name: "peanut butter", identity: null }, noEvidence))
      .toMatchObject({ verdict: "blocked" });
    expect(shoppingRuleMark({ name: "paper towels", identity: null }, noEvidence)).toBeNull();
  });

  it("marks typed text by a banned category the name implies", () => {
    const beans = context({ banned_categories: ["beans"] });
    expect(shoppingRuleMark({ name: "black beans", identity: null }, beans))
      .toEqual({ verdict: "blocked", reason: "black beans is in a category your rules exclude (beans)." });
    expect(shoppingRuleMark({ name: "paper towels", identity: null }, beans)).toBeNull();
  });

  it("marks typed text by a custom ingredient rule", () => {
    const rule = context({ custom_rules: [{ id: "00000000-0000-4000-8000-0000000000e1",
      kind: "ingredient", text: "cilantro" }] });
    expect(shoppingRuleMark({ name: "fresh cilantro", identity: null }, rule))
      .toMatchObject({ verdict: "blocked" });
    expect(shoppingRuleMark({ name: "paper towels", identity: null }, rule)).toBeNull();
  });

  it("judges a bundled food id by its own category and Avoid membership", () => {
    const foodDb = (foodDbId: string): IngredientIdentity => ({ foodRefId: null, foodDbId,
      catalogFoodRevisionId: null, purchaseState: "as_purchased", variantKey: "default" });
    expect(shoppingRuleMark({ name: "Black beans", identity: foodDb("black-beans-cooked") },
      context({ banned_categories: ["beans"] }))).toMatchObject({ verdict: "blocked" });
    expect(shoppingRuleMark({ name: "Store peanuts", identity: foodDb("peanuts") },
      context({}, { avoidFoodDbIds: ["peanuts"] })))
      .toMatchObject({ verdict: "blocked", reason: "Store peanuts is on your Avoid list." });
  });

  it("marks a line whose food ref is itself on Avoid", () => {
    const byRef = context({}, { avoidRefIds: [RICE_REF], byIdentity: {
      [`ref:${RICE_REF}`]: facts({ foodName: "Rice" }) } });
    expect(shoppingRuleMark({ name: "Rice", identity: ref(RICE_REF) }, byRef))
      .toMatchObject({ verdict: "blocked", reason: "Rice is on your Avoid list." });
  });

  it("judges a stored line with a missing name by its ref without failing the batch", () => {
    const marked = withShoppingRuleMarks([
      { name: undefined as unknown as string, identity: ref(PB_REF) },
      { name: "Rice", identity: ref(RICE_REF) },
    ], peanutAllergy);
    expect(marked[0].ruleMark).toEqual({ verdict: "blocked",
      reason: "This item has peanut, which your rules exclude." });
    expect(marked[1].ruleMark).toBeNull();
  });

  it("keeps order and every field when marking a batch", () => {
    const marked = withShoppingRuleMarks([
      { id: "a", name: "Peanut butter", identity: ref(PB_REF) },
      { id: "b", name: "Rice", identity: ref(RICE_REF) },
    ], peanutAllergy);
    expect(marked.map((item) => [item.id, item.ruleMark?.verdict ?? null]))
      .toEqual([["a", "blocked"], ["b", null]]);
  });

  it("marks referenced lines unknown when the evidence failed and no other rule is in hand", () => {
    const noEvidence = context({}, { evidenceStatus: "unavailable" });
    expect(shoppingRuleMark({ name: "Rice", identity: ref(RICE_REF) }, noEvidence))
      .toMatchObject({ verdict: "unknown" });
    expect(shoppingRuleMark({ name: "paper towels", identity: null }, noEvidence)).toBeNull();
  });

  it("marks referenced lines unknown when only the Avoid list or the profile failed", () => {
    const ready = context({ avoid_allergens: ["peanut"] }, { byIdentity: {
      [`ref:${RICE_REF}`]: facts({ foodName: "Rice" }) } });
    expect(shoppingRuleMark({ name: "Rice", identity: ref(RICE_REF) }, { ...ready, avoid: null }))
      .toMatchObject({ verdict: "unknown" });
    expect(shoppingRuleMark({ name: "Rice", identity: ref(RICE_REF) }, { ...ready, profile: null }))
      .toMatchObject({ verdict: "unknown" });
    // The allergen rule that WAS read still marks typed text when the Avoid list failed.
    expect(shoppingRuleMark({ name: "peanut butter", identity: null }, { ...ready, avoid: null }))
      .toMatchObject({ verdict: "blocked" });
    // And the Avoid list that WAS read still marks typed text when the profile failed.
    const avoids = context({}, { avoidNames: ["granola"] });
    expect(shoppingRuleMark({ name: "Granola", identity: null }, { ...avoids, profile: null }))
      .toMatchObject({ verdict: "blocked" });
  });

  it("judges each pinned revision of one ref on its own facts", () => {
    const pinned = (rev: number): IngredientIdentity => ({ foodRefId: PB_REF,
      catalogFoodRevisionId: rev, purchaseState: "as_purchased", variantKey: "default" });
    const both: ShoppingRuleContext = { ...peanutAllergy, evidence: { status: "ready",
      preferenceFlags: [], facts: new Map([
        [evidenceKey(PB_REF, 1), facts({ foodName: "Spread", allergenTags: ["peanut"] })],
        [evidenceKey(PB_REF, 2), facts({ foodName: "Spread",
          allergenEvidence: { peanut: { level: "not_listed", labelComplete: true } } })],
      ]) } };
    expect(shoppingRuleMark({ name: "Spread", identity: pinned(1) }, both))
      .toMatchObject({ verdict: "blocked" });
    expect(shoppingRuleMark({ name: "Spread", identity: pinned(2) }, both)).toBeNull();
  });

  it("keeps sibling lines when one line throws, and fails that line closed", () => {
    const exploding = { name: "Peanut butter", identity: { ...ref(PB_REF),
      get foodDbId(): string { throw new Error("bad row"); } } };
    const marked = withShoppingRuleMarks([exploding, { name: "Rice", identity: ref(RICE_REF) },
      null as unknown as { name: string; identity: null }], peanutAllergy);
    expect(marked[0].ruleMark).toMatchObject({ verdict: "unknown" });
    expect(marked[1].ruleMark).toBeNull();
    expect(marked[2].ruleMark).toBeNull();
  });

  it("marks a referenced line with no returned facts unknown unless its text blocks it", () => {
    const beans = context({ banned_categories: ["beans"] });
    const missing = (foodRefId: string): IngredientIdentity => ref(foodRefId);
    expect(shoppingRuleMark({ name: "Rice", identity: missing(RICE_REF) }, beans))
      .toEqual({ verdict: "unknown", reason: "We couldn't check Rice against your food rules." });
    expect(shoppingRuleMark({ name: "black beans", identity: missing(PB_REF) }, beans))
      .toMatchObject({ verdict: "blocked" });
  });

  it("marks a referenced line whose resolved food name is on Avoid", () => {
    const avoids = context({}, { avoidNames: ["peanut butter"], byIdentity: {
      [`ref:${PB_REF}`]: facts({ foodName: "Peanut butter, chunky" }) } });
    expect(shoppingRuleMark({ name: "Sandwich spread", identity: ref(PB_REF) }, avoids))
      .toEqual({ verdict: "blocked", reason: "Sandwich spread is on your Avoid list." });
  });

  it("still returns a line whose fields cannot be copied", () => {
    const odd = { name: "Peanut butter", identity: ref(PB_REF),
      get note(): string { throw new Error("bad field"); } };
    const [marked] = withShoppingRuleMarks([odd], peanutAllergy);
    expect(marked.ruleMark).toMatchObject({ verdict: "blocked" });
  });

  it("falls back to the bare text for a typed line that throws", () => {
    const typed = { name: "peanut butter", identity: { foodRefId: null,
      catalogFoodRevisionId: null, purchaseState: "as_purchased" as const, variantKey: "default",
      get foodDbId(): string { throw new Error("bad row"); } } };
    const [marked] = withShoppingRuleMarks([typed], peanutAllergy);
    expect(marked.ruleMark).toMatchObject({ verdict: "blocked" });
  });
});
