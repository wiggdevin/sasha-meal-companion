import { describe, expect, it } from "vitest";
import { badgeFor, gramsFor, searchHintText } from "@/components/ScanConfirmSheet";
import type { BarcodeMatch } from "@/lib/barcode/client";

const MATCH: BarcodeMatch = {
  foodRefId: "11111111-1111-4111-8111-111111111111", catalogFoodId: 12, revisionId: 34,
  description: "Apple & blueberry pouch", brand: "Ella's Kitchen", source: "off",
  qualityClass: "crowd", qualityFlags: [], per100g: { energy_kcal: 60 },
  portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
  ingredientsText: "Apple juice concentrate", allergenTags: ["apple"],
  attribution: "Data from Open Food Facts (ODbL)", policy: { verdict: "blocked", reason: "allergen:apple" },
};

describe("searchHintText", () => {
  it("joins what she can read off the package, in that order", () => {
    expect(searchHintText({ brand: "Ella's Kitchen", name: "pouch" })).toBe("Ella's Kitchen pouch");
    expect(searchHintText({ name: "pouch" })).toBe("pouch");
    expect(searchHintText({})).toBe("");
  });
});

describe("gramsFor", () => {
  it("multiplies the chosen portion, and falls back to 100 g per unit", () => {
    expect(gramsFor(MATCH, 5, 2)).toBe(180);
    expect(gramsFor(MATCH, null, 1.5)).toBe(150);
    expect(gramsFor({ ...MATCH, portions: [] }, 5, 1)).toBe(100);
  });
});

describe("badgeFor", () => {
  it("names the allergen on a blocked verdict", () => {
    expect(badgeFor(MATCH)).toEqual({ tone: "alert", label: "Contains apple" });
  });

  it("is amber and honest when there is no ingredient evidence", () => {
    expect(badgeFor({ ...MATCH, policy: { verdict: "unverified" }, allergenTags: [] }))
      .toEqual({ tone: "amber", label: "No ingredient list — check the pack" });
  });

  it("shows nothing when the food is allowed", () => {
    expect(badgeFor({ ...MATCH, policy: { verdict: "allowed" }, allergenTags: [] }).tone).toBe("none");
  });

  /* A block can come from three places (lib/policy/constraints.ts evaluatePolicy): an allergen
     match, her own avoid list, or a banned category — the same three every other surface
     (CoachSuggestion.tsx, lib/capture-client.ts policyCopy) already spells out by name. Before
     this test, badgeFor recognised only the allergen reason and guessed the other two from
     allergenTags[0], which names whichever allergen the product happens to carry — not the
     reason it was actually blocked for. */
  it("says she is on her own avoid list, not a guessed allergen", () => {
    expect(badgeFor({ ...MATCH, policy: { verdict: "blocked", reason: "avoid_list" }, allergenTags: ["soy"] }))
      .toEqual({ tone: "alert", label: "On your avoid list" });
  });

  it("names the banned category, not a guessed allergen", () => {
    expect(badgeFor({
      ...MATCH, policy: { verdict: "blocked", reason: "category:simple_sugars" }, allergenTags: ["soy"],
    })).toEqual({ tone: "alert", label: "On your avoid list: simple sugars" });
  });
});
