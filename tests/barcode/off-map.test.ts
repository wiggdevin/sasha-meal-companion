import { describe, expect, it } from "vitest";
import {
  atwaterKcal, emptyPer100g, offToRevision, scanAllergens, splitIngredients,
} from "@/lib/catalog/off-map";
import type { OffProduct } from "@/lib/catalog/off";

const FETCHED = "2026-09-19T12:00:00.000Z";

const POUCH: OffProduct = {
  product_name: "Apple & blueberry pouch",
  brands: "Ella's Kitchen, Ellas",
  serving_quantity: "90",
  serving_size: "1 pouch (90 g)",
  ingredients_text: "Apple juice concentrate, blueberry puree, water",
  allergens_tags: [],
  nutriments: {
    "energy-kcal_100g": 60, proteins_100g: 0.4, carbohydrates_100g: 13.5,
    fat_100g: 0.2, fiber_100g: 1.4, sugars_100g: 12.6, salt_100g: 0.03,
  },
};

describe("offToRevision", () => {
  it("tags apple from the ingredient text even when OFF declares no allergen", () => {
    const draft = offToRevision(POUCH, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.ingredients[0]).toEqual({
      seq: 1, name: "Apple juice concentrate", allergenTags: ["apple"],
    });
    expect(draft.ingredientsText).toBe("Apple juice concentrate, blueberry puree, water");
    expect(draft.description).toBe("Apple & blueberry pouch");
    expect(draft.brand).toBe("Ella's Kitchen");
    expect(draft.qualityClass).toBe("crowd");
    expect(draft.portions).toEqual([{ description: "1 pouch (90 g)", gramWeight: 90 }]);
  });

  it("rejects a product with no energy and no macros", () => {
    expect(offToRevision({ product_name: "Mystery", nutriments: {} }, FETCHED))
      .toEqual({ reject: "no_nutrition" });
    expect(offToRevision({ product_name: "Mystery" }, FETCHED))
      .toEqual({ reject: "no_nutrition" });
  });

  it("converts kJ-only energy and flags where the number came from", () => {
    const draft = offToRevision(
      { product_name: "Bar", nutriments: { energy_100g: 2343, proteins_100g: 10 } }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.per100g.energy_kcal).toBe(559.977);
    expect(draft.qualityFlags).toContain("off_energy_from_kj");
  });

  it("derives sodium from salt when sodium is absent", () => {
    const draft = offToRevision(
      { product_name: "Crisps", nutriments: { salt_100g: 1.25, proteins_100g: 6 } }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.per100g.sodium).toBe(500);
    expect(draft.qualityFlags).toContain("sodium_from_salt");
  });

  it("prefers a reported sodium over salt and leaves absent micros null, never 0", () => {
    const draft = offToRevision(
      { product_name: "Crisps", nutriments: { sodium_100g: 0.4, salt_100g: 1.25, proteins_100g: 6 } },
      FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.per100g.sodium).toBe(400);
    expect(draft.per100g.iron).toBeNull();
    expect(draft.per100g.vitamin_d).toBeNull();
    expect(draft.qualityFlags).not.toContain("sodium_from_salt");
  });

  it("flags energy_mismatch when the label kcal and Atwater disagree by over 10 %", () => {
    const draft = offToRevision({
      product_name: "Suspicious bar",
      nutriments: {
        "energy-kcal_100g": 250, proteins_100g: 10, carbohydrates_100g: 40,
        fat_100g: 20, fiber_100g: 0,
      },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.per100g.energy_kcal_calc).toBe(380);
    expect(draft.qualityFlags).toContain("energy_mismatch");
  });

  it("does not flag a mismatch when Atwater is incomplete", () => {
    const draft = offToRevision(
      { product_name: "Bar", nutriments: { "energy-kcal_100g": 250, proteins_100g: 10 } }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.per100g.energy_kcal_calc).toBeNull();
    expect(draft.qualityFlags).toContain("atwater_incomplete");
    expect(draft.qualityFlags).not.toContain("energy_mismatch");
  });

  it("carries OFF's own allergen and trace tags as a seq-0 row", () => {
    const draft = offToRevision({
      product_name: "Cookie", allergens_tags: ["en:gluten", "en:milk"], traces_tags: ["en:nuts"],
      ingredients_text: "Wheat flour, butter",
      nutriments: { "energy-kcal_100g": 480, proteins_100g: 6 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.ingredients[0]).toEqual({
      seq: 0, name: "Contains: gluten, dairy, nuts", allergenTags: ["gluten", "dairy", "nuts"],
    });
    expect(draft.ingredients[1]).toEqual({ seq: 1, name: "Wheat flour", allergenTags: ["gluten"] });
    expect(draft.qualityFlags).toContain("allergens_from_tags");
    expect(draft.sourceId).toBe("");
    expect(draft.publishedAt).toBe(FETCHED);
  });

  it("keeps a declared wheat tag as wheat, so the wheat allergen rule sees it directly, while " +
    "still carrying gluten too (finding #8)", () => {
    const draft = offToRevision({
      product_name: "Cracker", allergens_tags: ["en:wheat"],
      nutriments: { "energy-kcal_100g": 400, proteins_100g: 8 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.ingredients[0]).toEqual({
      seq: 0, name: "Contains: wheat, gluten", allergenTags: ["wheat", "gluten"],
    });
  });

  it.each(["en:spelt", "en:kamut", "en:triticale", "en:einkorn", "en:farro"])(
    "ORCHESTRATOR fix (item 1): %s is a wheat declaration too, not only gluten", (tag) => {
      const draft = offToRevision({
        product_name: "Ancient grain loaf", allergens_tags: [tag],
        nutriments: { "energy-kcal_100g": 250, proteins_100g: 8 },
      }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.ingredients[0]).toEqual({
        seq: 0, name: "Contains: wheat, gluten", allergenTags: ["wheat", "gluten"],
      });
    });

  it.each([
    "en:almonds", "en:cashews", "en:walnuts", "en:pecans", "en:pistachios", "en:hazelnuts",
    "en:macadamia-nuts", "en:brazil-nuts", "en:pine-nuts",
  ])(
    "review r2 sol/BLOCK: %s is a species-level OFF tag that maps to the tree-nut allergen rule's " +
    "own key, not a bare species word lib/policy/allergens.ts's tree-nut rule never matches by " +
    "tag — a product declaring it with no ingredient text must read as a tree-nut declaration, " +
    "not fall through to unverified", (tag) => {
      const draft = offToRevision({
        product_name: "Nut butter", allergens_tags: [tag],
        nutriments: { "energy-kcal_100g": 600, proteins_100g: 20 },
      }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.ingredients[0]).toEqual({
        seq: 0, name: "Contains: tree-nut", allergenTags: ["tree-nut"],
      });
    });

  it("still normalizes barley and rye, which have no rule of their own, to gluten", () => {
    const draft = offToRevision({
      product_name: "Bread", allergens_tags: ["en:barley", "en:rye"],
      nutriments: { "energy-kcal_100g": 250, proteins_100g: 8 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.ingredients[0]).toEqual({
      seq: 0, name: "Contains: gluten", allergenTags: ["gluten"],
    });
  });

  it("maps a simple-sugars OFF category tag to the banned-category name (finding #33)", () => {
    const draft = offToRevision({
      product_name: "Wildflower honey", categories_tags: ["en:sweeteners", "en:honeys"],
      nutriments: { "energy-kcal_100g": 304, carbohydrates_100g: 82 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.category).toBe("simple_sugars");
  });

  it("leaves category null for a product with no matching category tag", () => {
    const draft = offToRevision({
      product_name: "Bar", categories_tags: ["en:snacks", "en:granola-bars"],
      nutriments: { "energy-kcal_100g": 400, protein_100g: 8 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.category).toBeNull();
  });

  it("leaves category null when OFF sends no categories_tags at all", () => {
    const draft = offToRevision(
      { product_name: "Bar", nutriments: { "energy-kcal_100g": 400, proteins_100g: 8 } }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.category).toBeNull();
  });
});

describe("offToRevision quality-flags an unconfirmed text scan", () => {
  it("flags allergens_text_unconfirmed when there are no declared tags and the text scan finds nothing", () => {
    // Non-English ingredient text (wheat flour, milk, butter, apple) that scanAllergens' English
    // word lists miss entirely — the exact fail-open case finding #8 describes.
    const draft = offToRevision({
      product_name: "Imported bar",
      allergens_tags: [], traces_tags: [],
      ingredients_text: "Farine de blé, lait, beurre, pomme",
      nutriments: { "energy-kcal_100g": 400, proteins_100g: 5 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.qualityFlags).toContain("allergens_text_unconfirmed");
  });

  it("does not flag allergens_text_unconfirmed when the text scan finds a real match", () => {
    const draft = offToRevision({
      product_name: "Cookie",
      ingredients_text: "Wheat flour, butter",
      nutriments: { "energy-kcal_100g": 480, proteins_100g: 6 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.qualityFlags).not.toContain("allergens_text_unconfirmed");
  });

  it("does not flag allergens_text_unconfirmed when OFF already declared tags", () => {
    const draft = offToRevision({
      product_name: "Cookie",
      allergens_tags: ["en:gluten"],
      ingredients_text: "Farine de blé",
      nutriments: { "energy-kcal_100g": 480, proteins_100g: 6 },
    }, FETCHED);
    if ("reject" in draft) throw new Error(draft.reject);
    expect(draft.qualityFlags).not.toContain("allergens_text_unconfirmed");
  });
});

describe("scanAllergens", () => {
  it.each([
    ["Wheat flour", ["gluten"]],
    ["Whey protein concentrate", ["dairy"]],
    ["Sodium caseinate", ["dairy"]],
    ["Apple juice concentrate", ["apple"]],
    ["Pineapple juice", []],
    ["Malic acid", []],
    ["Almond milk", []],
    ["Gluten-free oats", []],
    ["Sunflower seed butter", []],
  ])("reads %s as %j", (text, expected) => {
    expect(scanAllergens(text)).toEqual(expected);
  });
});

describe("splitIngredients", () => {
  it("splits on top-level commas only and drops empties", () => {
    expect(splitIngredients("Oats, chocolate (cocoa mass, sugar), salt"))
      .toEqual(["Oats", "chocolate (cocoa mass, sugar)", "salt"]);
    expect(splitIngredients(null)).toEqual([]);
    expect(splitIngredients("  ,  ")).toEqual([]);
  });
});

describe("atwaterKcal", () => {
  it("uses available carbohydrate when fiber is reported", () => {
    const p = emptyPer100g();
    p.protein = 10; p.carbohydrate = 40; p.fat_total = 20; p.fiber_total = 5;
    expect(atwaterKcal(p)).toEqual({ kcal: 360, complete: true });
  });

  it("is incomplete when any of protein, carbohydrate or fat is null", () => {
    const p = emptyPer100g();
    p.protein = 10; p.carbohydrate = 40;
    expect(atwaterKcal(p)).toEqual({ kcal: null, complete: false });
  });
});
