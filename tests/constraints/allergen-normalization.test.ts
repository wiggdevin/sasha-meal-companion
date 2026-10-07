/**
 * Loop 010, 2026-09-14 — the most serious finding of the run.
 *
 * PUT /api/constraints with ["gluten ", "dairy", "apple"] — one trailing space — returned 200 and
 * stored the padded string verbatim. `missingFloorAllergen` trims AND lowercases the copy it
 * checks, so the 422 floor guard was satisfied; `evaluatePolicy` only lowercases, so the stored
 * "gluten " never equalled the tag "gluten" again.
 *
 * Measured against the running app on catalog food 13702 (allergen_tags includes gluten), same
 * user, same food, constraint the only variable:
 *   avoid_allergens ["gluten ", ...] -> {"verdict": "allowed"}
 *   avoid_allergens ["gluten",  ...] -> {"verdict": "blocked", "reason": "allergen:gluten"}
 *
 * For someone whose app exists to keep gluten, dairy and apple away from ulcerative colitis, a
 * silent whitespace bypass of the floor is the worst failure this codebase has. Both layers are
 * fixed: the boundary normalizes what it stores, and the comparison tolerates whitespace so an
 * already-stored padded row cannot bypass either.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { normalizeAllergens } from "@/lib/server/constraints";

const profile = (avoid: string[]) => ({
  avoid_allergens: avoid, avoid_food_ref_ids: [], banned_categories: [],
  conditions: [], notes: null,
});

describe("evaluatePolicy allergen matching", () => {
  it("blocks a gluten item when the stored allergen carries whitespace", () => {
    expect(evaluatePolicy(profile(["gluten ", "dairy", "apple"]),
      { allergenTags: ["gluten"], foodRefId: null, category: null, onEatsList: false, onAvoidList: false }).verdict).toBe("blocked");
  });

  it("blocks regardless of case and surrounding whitespace on either side", () => {
    for (const stored of ["  GLUTEN", "Gluten\t", " gluten "]) {
      expect(evaluatePolicy(profile([stored]),
        { allergenTags: ["gluten"], foodRefId: null, category: null, onEatsList: false, onAvoidList: false }).verdict)
        .toBe("blocked");
    }
  });

  it("blocks when the incoming tag is the padded one", () => {
    expect(evaluatePolicy(profile(["gluten"]),
      { allergenTags: [" Gluten "], foodRefId: null, category: null, onEatsList: false, onAvoidList: false }).verdict).toBe("blocked");
  });

  it("still allows a food that genuinely carries none of the avoided allergens", () => {
    // Phase 13 §5: "genuinely" needs evidence — a tag list without them is not enough on its own.
    expect(evaluatePolicy(profile(["gluten", "dairy", "apple"]),
      { allergenTags: ["soy"], foodRefId: null, category: null, onEatsList: false, onAvoidList: false,
        allergenEvidence: { dairy: { level: "not_listed", labelComplete: true } },
        checkedAllergens: ["gluten", "apple"] }).verdict).toBe("allowed");
    expect(evaluatePolicy(profile(["gluten", "dairy", "apple"]),
      { allergenTags: ["soy"], foodRefId: null, category: null, onEatsList: false, onAvoidList: false })
      .verdict).toBe("unverified");
  });
});

describe("normalizeAllergens", () => {
  it("trims and lowercases what gets stored, so the floor cannot be padded past", () => {
    expect(normalizeAllergens(["gluten ", "DAIRY", " apple"])).toEqual(["gluten", "dairy", "apple"]);
  });

  it("drops entries that are only whitespace rather than storing them", () => {
    expect(normalizeAllergens(["gluten", "   ", "dairy"])).toEqual(["gluten", "dairy"]);
  });

  it("removes duplicates that only differed by case or padding", () => {
    expect(normalizeAllergens(["gluten", "Gluten ", " GLUTEN"])).toEqual(["gluten"]);
  });
});
