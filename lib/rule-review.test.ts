import { describe, expect, it } from "vitest";
import { applyRuleChoices, reviewStatus } from "./rule-review";

const row = {
  avoid_allergens: ["gluten", "soy", "dairy"],
  banned_categories: ["beans", "simple_sugars", "personally_avoided"],
};

describe("historical food-rule provenance", () => {
  it("keeps the stored review marker authoritative even if candidate arrays change", () => {
    expect(reviewStatus(true, null, row)).toEqual({ required: true,
      candidateAllergens: ["gluten", "dairy"],
      candidateCategories: ["beans", "simple_sugars"] });
    expect(reviewStatus(false, null, row).required).toBe(false);
    expect(reviewStatus(true, "2026-09-26T00:00:00Z", row).required).toBe(false);
    expect(reviewStatus(true, null, { avoid_allergens: ["soy"],
      banned_categories: ["personally_avoided"] }).required).toBe(true);
  });

  it("keeps each chosen candidate and leaves unrelated authored rules untouched", () => {
    const status = reviewStatus(true, null, row);
    expect(() => applyRuleChoices(row, status, {
      allergens: { gluten: "keep", dairy: "remove" },
      categories: { beans: "remove" },
    })).toThrow(/every rule/i);
    expect(applyRuleChoices(row, status, {
      allergens: { gluten: "keep", dairy: "remove" },
      categories: { beans: "remove", simple_sugars: "keep" },
    })).toEqual({
      avoid_allergens: ["gluten", "soy"],
      banned_categories: ["simple_sugars", "personally_avoided"],
    });
  });
});
