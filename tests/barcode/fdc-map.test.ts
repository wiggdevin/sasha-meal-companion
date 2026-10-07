import { describe, expect, it } from "vitest";
import { convertAmount, fdcBrandedToRevision } from "@/lib/catalog/fdc-map";
import type { FdcBrandedFood } from "@/lib/catalog/fdc";

const FETCHED = "2026-09-19T12:00:00.000Z";

const BAR: FdcBrandedFood = {
  fdcId: 123456, description: "DARK CHOCOLATE NUTS & SEA SALT", brandName: "KIND",
  brandOwner: "KIND LLC", gtinUpc: "0602652171000", publishedDate: "2026-04-01",
  ingredients: "ALMONDS, WHEY PROTEIN, CHICORY ROOT FIBER", servingSize: 40,
  servingSizeUnit: "g", householdServingFullText: "1 bar",
  foodNutrients: [
    { nutrientId: 1008, unitName: "KCAL", value: 500 },
    { nutrientId: 1003, unitName: "G", value: 15 },
    { nutrientId: 1005, unitName: "G", value: 40 },
    { nutrientId: 1004, unitName: "G", value: 30 },
    { nutrientId: 1079, unitName: "G", value: 17.5 },
    { nutrientId: 1093, unitName: "MG", value: 350 },
    { nutrientId: 1089, unitName: "MG", value: 4 },
    { nutrientId: 1114, unitName: "UG", value: 2.5 },
    { nutrientId: 9999, unitName: "G", value: 1 },
  ],
};

describe("fdcBrandedToRevision", () => {
  it("maps the nutrient-id table, keeps the label class and reads the household portion", () => {
    const draft = fdcBrandedToRevision(BAR, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.qualityClass).toBe("label");
    expect(draft.description).toBe("DARK CHOCOLATE NUTS & SEA SALT");
    expect(draft.brand).toBe("KIND");
    expect(draft.per100g.energy_kcal).toBe(500);
    expect(draft.per100g.protein).toBe(15);
    expect(draft.per100g.sodium).toBe(350);
    expect(draft.per100g.iron).toBe(4);
    expect(draft.per100g.vitamin_d).toBe(2.5);
    expect(draft.per100g.energy_kcal_calc).toBe(420);
    expect(draft.per100g.zinc).toBeNull();
    expect(draft.portions).toEqual([{ description: "1 bar", gramWeight: 40 }]);
    expect(draft.publishedAt).toBe("2026-04-01");
  });

  it("tags dairy from the ingredient list", () => {
    const draft = fdcBrandedToRevision(BAR, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.ingredients[1]).toEqual({ seq: 2, name: "WHEY PROTEIN", allergenTags: ["dairy"] });
    expect(draft.ingredientsText).toBe("ALMONDS, WHEY PROTEIN, CHICORY ROOT FIBER");
  });

  it("rejects a food with none of the four", () => {
    expect(fdcBrandedToRevision({ fdcId: 1, description: "X", foodNutrients: [] }, FETCHED))
      .toEqual({ reject: "no_nutrition" });
  });

  it("ignores a serving size that is not grams and falls back to fetchedAt", () => {
    const draft = fdcBrandedToRevision(
      { ...BAR, servingSizeUnit: "ml", publishedDate: undefined }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.portions).toEqual([]);
    expect(draft.publishedAt).toBe(FETCHED);
  });

  it("maps FDC's brandedFoodCategory to the banned-category name (finding #33)", () => {
    const draft = fdcBrandedToRevision({ ...BAR, brandedFoodCategory: "Honey" }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.category).toBe("simple_sugars");
  });

  it("leaves category null when brandedFoodCategory is absent or unrecognized", () => {
    const draft = fdcBrandedToRevision(BAR, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.category).toBeNull();
  });
});

describe("convertAmount", () => {
  it.each([
    [1, "G", "sodium", 1000],
    [1000, "UG", "sodium", 1],
    [2, "MG", "vitamin_d", 2000],
    [5, "G", "protein", 5],
    [5, "IU", "vitamin_d", null],
  ])("converts %s %s for %s", (value, unit, code, expected) => {
    expect(convertAmount(value as number, unit as string, code as never)).toBe(expected);
  });
});
