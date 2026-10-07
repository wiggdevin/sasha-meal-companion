/**
 * sol BLOCK (review round 1, finding #4): a grounded label capture used to discard the catalog
 * revision's own structured `allergen_tags` column whenever the item was a label scan — reading
 * only the OCR label text's own derived tags. Before a new revision's background evidence warm
 * completes, a catalog row tagged `peanut` plus an OCR label that OMITS peanut used to read
 * `allowed`; the barcode path for the exact same revision would block it.
 */
import { describe, expect, it } from "vitest";
import { combineAllergenTags, groundItem, labelFoodOf } from "@/lib/server/capture";
import type { CaptureItem, LabelNutrients } from "@/lib/ai/schemas";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { ScoredHit } from "@/lib/capture/grounding";

describe("combineAllergenTags", () => {
  it("is null only when neither source has anything to add", () => {
    expect(combineAllergenTags(null, null)).toBeNull();
  });
  it("keeps a tag either source names, deduped", () => {
    expect(combineAllergenTags(["peanut"], null)).toEqual(["peanut"]);
    expect(combineAllergenTags(null, ["peanut"])).toEqual(["peanut"]);
    expect(combineAllergenTags(["peanut"], ["peanut", "dairy"])).toEqual(["peanut", "dairy"]);
  });
});

const PROFILE: ConstraintProfile = { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
  banned_categories: [] };

const HIT: ScoredHit = { catalogFoodId: 7, revisionId: 70, description: "Trail mix bar",
  brand: null, score: 0.95 };

const ITEM: CaptureItem = { label: "Trail mix bar", grams: 40, qty: 1, unit: "bar", confidence: 0.9 };

/** A photo/label item whose model output omitted peanut, matched to a catalog revision whose own
 *  `allergen_tags` column already names it (an OCR miss, or a warm job that has not run yet). */
const LABEL: LabelNutrients = { name: "Trail mix bar", servingGrams: 40,
  per100g: { energy_kcal: 200 } as LabelNutrients["per100g"],
  ingredientsText: "Oats, honey, raisins." };

function makeClient(byTable: Record<string, { data: unknown; error: unknown }>) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const method of ["select", "eq", "in", "limit", "order", "range"]) chain[method] = self;
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(byTable[table] ?? { data: [], error: null }).then(onFulfilled, onRejected);
    return chain;
  };
  const rpc = () => Promise.resolve({ data: "ref-1", error: null });
  return { from, rpc } as never;
}

async function searchFoods() {
  return { hits: [HIT], queryClass: "generic" as const, catalogVersion: "v1", autoResolve: null };
}

describe("groundItem: a label capture that grounds to a catalog revision", () => {
  it("still blocks on the revision's own allergen_tags column even when the label's OCR text " +
    "omits that allergen (finding #4)", async () => {
    const client = makeClient({
      catalog_portions: { data: [], error: null },
      catalog_ingredients: { data: [
        { seq: 1, name: "peanut", raw_text: null, allergen_tags: ["peanut"] },
      ], error: null },
      food_allergen_evidence: { data: [], error: null },
      user_allergen_checks: { data: [], error: null },
    });
    const result = await groundItem(client, "u1", ITEM, LABEL, PROFILE, searchFoods as never);
    expect(result.verdict).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
  });

  it("sol FIX (review round 1, finding #7): hands back the user's own checked-allergens mark, " +
    "the same one its own verdict already merged in — so the capture card built from it can " +
    "read the check too, instead of only the verdict", async () => {
    const client = makeClient({
      catalog_portions: { data: [], error: null },
      catalog_ingredients: { data: [
        { seq: 1, name: "peanut", raw_text: null, allergen_tags: ["peanut"] },
      ], error: null },
      food_allergen_evidence: { data: [], error: null },
      user_allergen_checks: { data: [{ food_key: "catalog_revision:70", allergen: "peanut" }],
        error: null },
    });
    const result = await groundItem(client, "u1", ITEM, LABEL, PROFILE, searchFoods as never);
    expect(result.checkedAllergens).toEqual(["peanut"]);
  });
});

describe("groundItem: a photo/voice item with no label, grounded to a catalog revision whose " +
  "verbatim seq-1 statement is complete but a LATER, untagged row names the allergen on its own " +
  "(review round 2, sol BLOCK, lib/server/capture.ts allergenTagsFor)", () => {
  const SESAME_PROFILE: ConstraintProfile = { avoid_allergens: ["sesame"],
    avoid_food_ref_ids: [], banned_categories: [] };

  it("still blocks — search and detail already catch a later row's own parsed name the same way " +
    "(lib/server/catalog.ts's namedAllergenHints); capture must not disagree with them just " +
    "because seq 1's own verbatim text reads as a complete, sesame-free label on its own", async () => {
    const client = makeClient({
      catalog_portions: { data: [], error: null },
      catalog_ingredients: { data: [
        { seq: 1, name: "Oats, honey, raisins.", raw_text: "Oats, honey, raisins.",
          allergen_tags: null },
        // No raw_text of its own (so completenessText still reads seq 1 alone as verbatim and
        // complete) and no allergen_tags entry — the exact shape a structured-tags-only read
        // drops. Its NAME still names the allergen, same as the "peanut" row search's own
        // namedAllergenHints fallback already catches.
        { seq: 2, name: "sesame", raw_text: null, allergen_tags: null },
      ], error: null },
      food_allergen_evidence: { data: [], error: null },
      user_allergen_checks: { data: [], error: null },
    });
    const result = await groundItem(client, "u1", ITEM, null, SESAME_PROFILE, searchFoods as never);
    expect(result.verdict).toMatchObject({ verdict: "blocked", reason: "allergen:sesame" });
  });
});

describe("round 13, item 3: labelFoodOf must not disagree with groundItem's own verdict", () => {
  it("the card reads the same merged tags the verdict blocked on, instead of the photo text alone", async () => {
    const client = makeClient({
      catalog_portions: { data: [], error: null },
      catalog_ingredients: { data: [
        { seq: 1, name: "peanut", raw_text: null, allergen_tags: ["peanut"] },
      ], error: null },
      // No stored evidence yet (the background warm has not run) — the ONLY thing that names
      // peanut here is the revision's own structured allergen_tags column read fresh above.
      food_allergen_evidence: { data: [], error: null },
      user_allergen_checks: { data: [], error: null },
    });
    const result = await groundItem(client, "u1", ITEM, LABEL, PROFILE, searchFoods as never);
    expect(result.verdict).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });

    const card = labelFoodOf(LABEL, PROFILE, result.storedEvidence, result.checkedAllergens,
      result.allergenTags);
    const peanutWarning = card?.allergenWarnings?.find((w) => w.allergen === "peanut");
    expect(peanutWarning).toMatchObject({ outcome: "present", text: "Contains peanut" });
  });
});

/**
 * 2026-10-02 DeepSeek audit (F1, HIGH): the label capture verdict passed no `foodBrand` and no
 * `packaged` to evaluatePolicy, so a packaged "Chicken breast" nutrition-panel photo (no ingredient
 * list in frame, no brand string — an unbranded store label is still packaged) fell through to
 * lib/policy/whole-foods.ts's whole-food clearance: "Plain poultry has no dairy", even though the
 * label card right beside it (labelFindings, no name passed) still said "Check the label for
 * dairy" — two surfaces disagreeing about the same packaged product.
 */
describe("groundItem: a label capture never gets whole-food clearance (finding #1)", () => {
  const DAIRY_PROFILE: ConstraintProfile = { avoid_allergens: ["dairy"], avoid_food_ref_ids: [],
    banned_categories: [] };
  // A nutrition-panel-only photo: no ingredient list in frame, and no brand string either — an
  // unbranded store label for a generic-sounding name is still a packaged product.
  const CHICKEN_LABEL: LabelNutrients = { name: "Chicken breast", servingGrams: 85,
    per100g: { energy_kcal: 120 } as LabelNutrients["per100g"] };
  const CHICKEN_HIT: ScoredHit = { catalogFoodId: 8, revisionId: 80,
    description: "Chicken breast", brand: null, score: 0.9 };

  async function searchChicken() {
    return { hits: [CHICKEN_HIT], queryClass: "generic" as const, catalogVersion: "v1",
      autoResolve: null };
  }

  it("stays unverified ('Check the label') instead of clearing as a plain whole food", async () => {
    const client = makeClient({
      catalog_portions: { data: [], error: null },
      catalog_ingredients: { data: [], error: null },
      food_allergen_evidence: { data: [], error: null },
      user_allergen_checks: { data: [], error: null },
    });
    const result = await groundItem(
      client, "u1", ITEM, CHICKEN_LABEL, DAIRY_PROFILE, searchChicken as never);
    expect(result.verdict.verdict).toBe("unverified");
    expect(result.verdict.allergens).toContainEqual(
      expect.objectContaining({ allergen: "dairy", outcome: "unknown",
        text: "Check the label for dairy" }));
  });
});
