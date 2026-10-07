import { describe, expect, it } from "vitest";
import { NEW_FACETS } from "@/lib/foods/facet-vocabulary";
import { evaluateNewFacet } from "@/lib/policy/profiles/new-facets";

describe("evaluateNewFacet (map §5.2 first-value-order facets, deterministic-only)", () => {
  it("every NEW_FACETS id has a rule and returns unknown on empty evidence", () => {
    for (const facet of NEW_FACETS) {
      expect(evaluateNewFacet(facet, { text: "" }), facet).toBe("unknown");
    }
  });

  it.each([
    ["red_meat", "Angus beef patty", "present"],
    ["red_meat", "grilled chicken breast", "unknown"],
    ["poultry", "roast turkey breast", "present"],
    ["poultry", "beef stew", "unknown"],
    ["processed_meat", "hickory smoked bacon", "present"],
    ["processed_meat", "fresh pork loin", "unknown"],
    ["raw_or_undercooked_animal", "salmon sashimi platter", "present"],
    ["raw_or_undercooked_animal", "grilled salmon fillet", "unknown"],
    ["unpasteurized", "raw milk cheddar", "present"],
    ["unpasteurized", "pasteurized whole milk", "unknown"],
    ["high_mercury_fish", "swordfish steak", "present"],
    ["high_mercury_fish", "canned light tuna", "absent"],
    ["high_mercury_fish", "seared ahi tuna", "present"],
    // sol FIX: a named high-mercury species wins over a broad lower-mercury exclusion.
    ["high_mercury_fish", "canned bigeye tuna", "present"],
    ["high_mercury_fish", "albacore tuna with swordfish", "present"],
    ["high_mercury_fish", "canned albacore tuna", "absent"],
    ["high_mercury_fish", "wild salmon fillet", "unknown"],
    ["ultra_processed", "contains high fructose corn syrup", "present"],
    ["ultra_processed", "plain steel-cut oats", "unknown"],
  ] as const)("%s: %j -> %s", (facet, text, expected) => {
    expect(evaluateNewFacet(facet, { text })).toBe(expected);
  });

  it("high_listeria_risk defaults to present when preparation is unstated, per the map's own rubric", () => {
    expect(evaluateNewFacet("high_listeria_risk", { text: "deli meat sandwich" })).toBe("present");
    expect(evaluateNewFacet("high_listeria_risk", { text: "deli meat sandwich", statedFullyCooked: true }))
      .toBe("absent");
    expect(evaluateNewFacet("high_listeria_risk", { text: "grilled chicken sandwich" })).toBe("unknown");
  });

  it("high_sodium reads the sodium_mg deterministic bands (§5.2's own cutoffs)", () => {
    expect(evaluateNewFacet("high_sodium", { text: "", nutrientsPerServing: { sodium: 900 } }))
      .toBe("present");
    expect(evaluateNewFacet("high_sodium", { text: "", nutrientsPerServing: { sodium: 50 } }))
      .toBe("absent");
    expect(evaluateNewFacet("high_sodium", { text: "", nutrientsPerServing: { sodium: 300 } }))
      .toBe("unknown");
    expect(evaluateNewFacet("high_sodium", { text: "" })).toBe("unknown");
  });

  it("added_sugar reads the sugars_total proxy against the map's cutoffs", () => {
    expect(evaluateNewFacet("added_sugar", { text: "", nutrientsPerServing: { sugars_total: 20 } }))
      .toBe("present");
    expect(evaluateNewFacet("added_sugar", { text: "", nutrientsPerServing: { sugars_total: 1 } }))
      .toBe("absent");
  });

  it("protein_dense reads protein per 100 kcal", () => {
    expect(evaluateNewFacet("protein_dense",
      { text: "", nutrientsPerServing: { protein: 30, energy_kcal: 150 } })).toBe("present"); // 20/100kcal
    expect(evaluateNewFacet("protein_dense",
      { text: "", nutrientsPerServing: { protein: 2, energy_kcal: 200 } })).toBe("absent"); // 1/100kcal
    expect(evaluateNewFacet("protein_dense", { text: "", nutrientsPerServing: { protein: 5 } }))
      .toBe("unknown"); // no kcal
    expect(evaluateNewFacet("protein_dense",
      { text: "", nutrientsPerServing: { protein: 10, energy_kcal: 0 } })).toBe("unknown"); // zero kcal guard
  });
});
