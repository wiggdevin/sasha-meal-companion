/**
 * round 13, item 1: coach barcode attachments (barcodeDraft) must inherit the same fix as the
 * barcode card (lib/server/barcode.ts toMatch) — mergeScannedAllergenFacts's own `verbatim` flag
 * has to reach evaluatePolicy's final check as `ingredientsTextIsLabel`, or a nonverbatim,
 * name-joined ingredient list silently reads as the label's own complete statement and clears a
 * major allergen a peanut-avoiding account never actually saw ruled out.
 */
import { describe, expect, it } from "vitest";
import { barcodeDraft } from "@/lib/server/coach-attachments";
import { fakeClient } from "../barcode/fake-client";

const REVISION = {
  id: 90, catalog_food_id: 9, description: "Snack mix", brand: null,
  category: null, policy_categories: [], quality_class: "crowd", quality_flags: [],
  catalog_versions: { version_label: "off-2026-09" },
  catalog_food_nutrients: [], catalog_portions: [],
  catalog_ingredients: [
    { seq: 1, name: "Water", allergen_tags: [], raw_text: null },
    { seq: 2, name: "rice", allergen_tags: [], raw_text: null },
    { seq: 3, name: "salt.", allergen_tags: [], raw_text: null },
  ],
};

describe("barcodeDraft: the coach attachment hot path", () => {
  it("carries the nonverbatim flag through the same way the barcode card does", async () => {
    const { client } = fakeClient({
      catalog_food_revisions: [REVISION],
      catalog_barcodes: [{ gtin14: "00000000000000", catalog_food_id: 9, source: "off" }],
      food_refs: [{ id: "ref-1", catalog_food_id: 9 }],
      user_food_prefs: [],
      constraint_profiles: [{ avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [] }],
      food_allergen_evidence: [],
      user_allergen_checks: [],
    });

    const draft = await barcodeDraft(client, "u1",
      { kind: "barcode", gtin14: "00000000000000", revisionId: "90", foodRefId: "ref-1" } as never);

    if (!("status" in draft) || draft.status !== "resolved") throw new Error("expected a resolved draft");
    expect(draft.match.policy.verdict).toBe("unverified");
    expect(draft.match.policy.allergens).toContainEqual(
      expect.objectContaining({ allergen: "peanut", outcome: "unknown", text: "Check the label for peanut" }),
    );
  });

  // 2026-10-02 DeepSeek audit (HIGH, finding #2): the coach barcode attachment is a packaged
  // lane too (the same product the barcode card would resolve) — an unbranded, no-ingredient
  // "Chicken breast" row must never read as a generic whole food here either.
  it("never gives a packaged attachment whole-food clearance, even unbranded (finding #2)", async () => {
    const { client } = fakeClient({
      catalog_food_revisions: [{ ...REVISION, id: 91, description: "Chicken breast", brand: null,
        catalog_ingredients: [] }],
      catalog_barcodes: [{ gtin14: "00000000000001", catalog_food_id: 9, source: "off" }],
      food_refs: [{ id: "ref-2", catalog_food_id: 9 }],
      user_food_prefs: [],
      constraint_profiles: [{ avoid_allergens: ["dairy"], avoid_food_ref_ids: [], banned_categories: [] }],
      food_allergen_evidence: [],
      user_allergen_checks: [],
    });

    const draft = await barcodeDraft(client, "u1",
      { kind: "barcode", gtin14: "00000000000001", revisionId: "91", foodRefId: "ref-2" } as never);

    if (!("status" in draft) || draft.status !== "resolved") throw new Error("expected a resolved draft");
    expect(draft.match.policy.allergens).toContainEqual(
      expect.objectContaining({ allergen: "dairy", outcome: "unknown", text: "Check the label for dairy" }),
    );
  });
});
