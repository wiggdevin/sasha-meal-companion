/**
 * 2026-10-03 recipe coverage: a recipe line clears by its catalog food's own description, never by
 * the recipe wording joined to it, and only when the wording names the same plain food with
 * nothing composite or ready-made around it. Every escalation still reads the joined name.
 */
import { describe, expect, it } from "vitest";
import { allergenFinding } from "@/lib/policy/allergens";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { classifyWholeFood } from "@/lib/policy/whole-foods";
import type { CatalogRecipe, RecipeIngredient } from "@/lib/recipe-catalog/types";
import { recipeEligibility, wholeFoodNameFor } from "@/lib/recipes/eligibility";

const SALMON = "Fish, salmon, Atlantic, farmed, cooked, dry heat";
const CHICKEN = "Chicken, broilers or fryers, breast, meat only, cooked, roasted";
const EGG = "Egg, whole, cooked, hard-boiled";
const OIL = "Oil, olive, salad or cooking";
const WATER = "Water, bottled, generic";
const LEMON = "Lemons, raw, without peel";
const TOMATO = "Tomatoes, red, ripe, raw, year round average";
const SIRLOIN = "Beef, top sirloin, steak, separable lean only, trimmed to 0\" fat, choice, cooked, broiled";
const RICE = "Rice, white, long-grain, regular, cooked, unenriched, with salt";

const profile = { ...EMPTY_PROFILE, avoid_allergens: ["gluten", "dairy"] };

function line(seq: number, name: string): RecipeIngredient {
  return { seq, name, foodRefId: `ref-${seq}`, catalogFoodRevisionId: 100 + seq, foodDbId: null,
    quantity: 100, unit: "g", grams: 100, state: "cooked", required: true, purchaseGrams: null,
    purchaseConversionStatus: "unknown", nutrition: {}, allergenEvidence: {} };
}

function recipe(lines: RecipeIngredient[]): CatalogRecipe {
  return { sourceKind: "shared", recipeId: "r", revisionId: "r:1", publicationState: "published",
    withdrawalReason: null, name: "Test plate", cuisine: "American", dishTags: [],
    activeMinutes: 5, totalMinutes: 5, effort: "none", servings: 1, yieldGrams: null,
    yieldStatus: "unknown", minServingFraction: 0.5, maxServingFraction: 2, ingredients: lines,
    steps: [{ seq: 1, text: "Plate it." }], nutritionPerServing: {},
    source: { author: "Meal Companion", sourceUrl: null, rightsKind: "original",
      rightsRecord: "Original. Not kitchen-tested.", sourceRevision: "t", kitchenTested: false } };
}

/** One line, its catalog description as the evidence food name, judged for gluten and dairy. */
function status(name: string, description: string, facets?: Record<string, { p: number }>) {
  const evidence = { 1: { foodName: description, category: [] as string[],
    ...(facets ? { facets } : {}) } };
  return recipeEligibility(recipe([line(1, name)]),
    { profile, evidenceBySeq: evidence as never }).status;
}

describe("whole-food classes for the recipe pilot's USDA rows", () => {
  it("classifies single olive oil, plain water, lemon, tomato and a fresh sirloin cut", () => {
    expect(classifyWholeFood({ foodName: OIL })?.label).toBe("plant oil");
    expect(classifyWholeFood({ foodName: "Oil, avocado" })?.label).toBe("plant oil");
    expect(classifyWholeFood({ foodName: WATER })?.label).toBe("water");
    expect(classifyWholeFood({ foodName: "Water" })?.label).toBe("water");
    expect(classifyWholeFood({ foodName: LEMON })?.label).toBe("fruit");
    expect(classifyWholeFood({ foodName: TOMATO })?.label).toBe("vegetables");
    // The singular never matched before ("tomatoes?" needs "tomatoe").
    expect(classifyWholeFood({ foodName: "Tomato" })?.label).toBe("vegetables");
    expect(classifyWholeFood({ foodName: SIRLOIN })).toEqual({ label: "red meat", intrinsic: [] });
  });

  it("leaves flavored or enhanced water, oil blends, sprays and infusions unclassified", () => {
    for (const foodName of ["Flavored water", "Water, bottled, flavored", "Tonic water",
      "Coconut water", "Sparkling water, lemon", "Water, with corn syrup, fruit flavored",
      "Water, bottled, PERRIER", "Oil, olive and canola blend", "Olive oil spray",
      "Oil, garlic-infused olive", "Oil, olive, salad or cooking, with garlic", "Oil",
      "Oil, soybean, salad or cooking", "Salad, olive oil"]) {
      expect(classifyWholeFood({ foodName }), foodName).toBeNull();
    }
  });

  it("leaves lemon curd, lemon juice products, tomato sauce, ketchup and canned tomato unclassified", () => {
    for (const foodName of ["Lemon curd", "Lemon juice, bottled", "Lemonade",
      "Tomato sauce", "Sauce, tomato", "Ketchup", "Catsup", "Tomatoes, canned",
      "Tomatoes, sun-dried", "Tomato products, canned, paste", "Tomatoes, red, ripe, canned, packed in tomato juice"]) {
      expect(classifyWholeFood({ foodName }), foodName).toBeNull();
    }
  });

  it("keeps cured, ground-patty, jerky and processed beef out of the red-meat class", () => {
    for (const foodName of ["Beef, cured, corned beef, brisket, cooked", "Beef jerky",
      "Beef, ground, 90% lean meat / 10% fat, patty, cooked, broiled",
      "Beef, top sirloin, steak, marinated, cooked", "Beef, top sirloin, steak, breaded"]) {
      expect(classifyWholeFood({ foodName }), foodName).toBeNull();
    }
  });
});

describe("recipe line clearance reads the catalog description, not the joined name", () => {
  it("clears plain wording that names the same food as its catalog row", () => {
    expect(wholeFoodNameFor(line(1, "cooked salmon"), SALMON)).toBe(SALMON);
    expect(wholeFoodNameFor(line(1, "roasted chicken breast"), CHICKEN)).toBe(CHICKEN);
    expect(wholeFoodNameFor(line(1, "hard-boiled eggs"), EGG)).toBe(EGG);
    expect(wholeFoodNameFor(line(1, "olive oil"), OIL)).toBe(OIL);
    expect(wholeFoodNameFor(line(1, "water"), WATER)).toBe(WATER);
    expect(wholeFoodNameFor(line(1, "lemon"), LEMON)).toBe(LEMON);
    expect(wholeFoodNameFor(line(1, "sirloin steak, sliced"), SIRLOIN)).toBe(SIRLOIN);
    for (const [name, description] of [["cooked salmon", SALMON], ["roasted chicken breast", CHICKEN],
      ["olive oil", OIL], ["water", WATER], ["lemon", LEMON], ["tomato, diced", TOMATO],
      ["sirloin steak, sliced", SIRLOIN]] as const) {
      expect(status(name, description), name).toBe("eligible");
    }
  });

  it("gives no clearance when the wording adds a sauce, breading, second food or ready-made product", () => {
    for (const [name, description] of [["breaded chicken breast", CHICKEN],
      ["soy-sauce salmon", SALMON], ["teriyaki salmon", SALMON], ["egg noodles", EGG],
      ["lemon juice and segments", LEMON], ["ready-to-eat roasted chicken breast", CHICKEN],
      ["rotisserie chicken", CHICKEN], ["marinated sirloin steak", SIRLOIN],
      ["tomato sauce", TOMATO], ["lemon curd", LEMON], ["flavored water", WATER]] as const) {
      expect(wholeFoodNameFor(line(1, name), description), name).toBeNull();
      expect(status(name, description), name).not.toBe("eligible");
    }
  });

  it("still blocks gluten and dairy foods named by the recipe wording", () => {
    // "Breaded" names no allergen word, so it stays unverified (excluded from candidates) rather
    // than listed — the same verdict as before this change, never cleared.
    expect(status("breaded chicken breast", CHICKEN)).toBe("unknown");
    expect(status("soy-sauce salmon", SALMON)).not.toBe("eligible");
    expect(status("rice crackers with wheat", RICE)).toBe("blocked");
    expect(status("cheese", "Cheese, cheddar")).toBe("blocked");
    expect(status("butter", "Butter, salted")).toBe("blocked");
    expect(status("egg noodles", "Noodles, egg, cooked, enriched")).not.toBe("eligible");
  });

  it("a stored listed finding still blocks a plain whole food", () => {
    const blocked = recipeEligibility(recipe([line(1, "cooked salmon")]), { profile,
      evidenceBySeq: { 1: { foodName: SALMON, category: [],
        allergenEvidence: { gluten: { level: "listed", labelComplete: false } } } } });
    expect(blocked.status).toBe("blocked");
  });

  // Phase 18 W2a: a Jev score is no longer allergen evidence. The ready-made line has no
  // deterministic evidence either way, so it is unverified (never eligible), not blocked.
  it("ignores a weak Jev dairy score: plain eggs clear by class, a ready-made line stays unverified", () => {
    const weakDairy = { contains_dairy: { p: 0.11 } };
    expect(status("hard-boiled eggs", EGG, weakDairy)).toBe("eligible");
    expect(status("ready-to-eat hard-boiled eggs", EGG, weakDairy)).toBe("unknown");
  });

  it("keeps the single-name behavior for callers that pass no clearance name", () => {
    expect(allergenFinding("gluten", { foodName: "Chicken breast" }))
      .toMatchObject({ outcome: "absent" });
    expect(allergenFinding("gluten", { foodName: "Chicken breast", wholeFoodName: null }))
      .toMatchObject({ outcome: "unknown" });
    expect(allergenFinding("dairy", { foodName: "cheese plate", wholeFoodName: "Chicken breast" }))
      .toMatchObject({ outcome: "present" });
  });
});

/** PR #333 audits (Grok B1/B2, DeepSeek): single-allergen profiles, so no second allergen hides a clear. */
function statusOn(avoid: string[], name: string, description: string) {
  return recipeEligibility(recipe([line(1, name)]), {
    profile: { ...EMPTY_PROFILE, avoid_allergens: avoid },
    evidenceBySeq: { 1: { foodName: description, category: [] } } as never,
  }).status;
}
const QUINOA = "Quinoa, cooked";

describe("audit negatives: wording must be the same plain food as its catalog row", () => {
  it("never clears a composite dish whose words strip down to a plain food (gluten-only)", () => {
    expect(statusOn(["gluten"], "grilled cheese", "Cheese, cheddar")).not.toBe("eligible");
    expect(statusOn(["gluten"], "grilled cheese", "Cheese")).not.toBe("eligible");
    expect(statusOn(["gluten"], "baked beans",
      "Beans, black, mature seeds, cooked, boiled, without salt")).not.toBe("eligible");
    expect(statusOn(["gluten"], "baked beans", "Beans")).not.toBe("eligible");
    for (const [name, row] of [["chicken sandwich", CHICKEN], ["salmon toast", SALMON],
      ["chicken pie", CHICKEN], ["egg toast", EGG]] as const) {
      expect(statusOn(["gluten"], name, row), name).not.toBe("eligible");
    }
  });

  it("never clears a different food that shares a class label", () => {
    expect(statusOn(["gluten"], "couscous", QUINOA)).not.toBe("eligible");
    expect(statusOn(["gluten"], "cooked bulgur", QUINOA)).not.toBe("eligible");
    expect(statusOn(["tree-nut"], "coconut", LEMON)).not.toBe("eligible");
    expect(statusOn(["gluten"], "cooked cod", SALMON)).not.toBe("eligible");
    expect(statusOn(["gluten"], "garlic", TOMATO)).not.toBe("eligible");
    expect(wholeFoodNameFor(line(1, "couscous"), QUINOA)).toBeNull();
    expect(wholeFoodNameFor(line(1, "coconut"), LEMON)).toBeNull();
  });

  it("refuses every prepared or processed form by the wording's own guard (gluten-only)", () => {
    for (const word of ["breaded", "battered", "marinated", "seasoned", "glazed", "smoked",
      "cured", "candied", "sweetened", "flavored", "infused"]) {
      const name = `${word} chicken breast`;
      expect(wholeFoodNameFor(line(1, name), CHICKEN), name).toBeNull();
      expect(statusOn(["gluten"], name, CHICKEN), name).not.toBe("eligible");
    }
  });

  it("allows only listed doneness and cut words, and nothing left over", () => {
    expect(wholeFoodNameFor(line(1, "cooked quinoa"), QUINOA)).toBe(QUINOA);
    expect(statusOn(["gluten"], "cooked quinoa", QUINOA)).toBe("eligible");
    expect(statusOn(["gluten"], "roasted chicken breast", CHICKEN)).toBe("eligible");
    for (const [name, row] of [["crispy chicken breast", CHICKEN],
      ["chicken breast strips", CHICKEN], ["spicy salmon", SALMON], ["quinoa salad", QUINOA],
      ["quinoa, toasted", QUINOA], ["baby spinach", CHICKEN]] as const) {
      expect(wholeFoodNameFor(line(1, name), row), name).toBeNull();
    }
  });

  it("does not let a blend through the olive-oil use note by case or spacing", () => {
    expect(classifyWholeFood({ foodName: "OIL, OLIVE, SALAD OR COOKING" })?.label).toBe("plant oil");
    for (const foodName of ["Oil, olive and canola, salad or cooking",
      "Oil,  olive, salad or cooking blend", "Oil, olive, salad or cooking, blend",
      "Oil, olive blend, salad or cooking", "Oil, canola, salad or cooking",
      "Oil, olive,  salad  or  cooking, with garlic"]) {
      expect(classifyWholeFood({ foodName }), foodName).toBeNull();
    }
    expect(wholeFoodNameFor(line(1, "olive oil blend"), OIL)).toBeNull();
  });
});
