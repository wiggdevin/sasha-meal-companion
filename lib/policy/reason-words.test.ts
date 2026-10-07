import { describe, expect, it } from "vitest";
import { reasonFragment, reasonLabel } from "@/lib/policy/reason-words";

describe("reason words", () => {
  it("says what a W2c diet facet is, never the code", () => {
    expect(reasonFragment("facet:meat")).toBe("contains meat, which your rules exclude.");
    expect(reasonFragment("facet:pork")).toBe("contains pork, which your rules exclude.");
    expect(reasonFragment("facet:fish_seafood")).toBe("contains fish or seafood, which your rules exclude.");
    expect(reasonFragment("facet:animal_product")).toBe("contains animal products, which your rules exclude.");
    expect(reasonFragment("facet:alcohol")).toBe("contains alcohol, which your rules exclude.");
    expect(reasonLabel("facet:meat")).toBe("Meat");
    expect(reasonLabel("facet:beef")).toBe("Contains beef");
  });

  it("reads a profile hard rule on a facet the same way", () => {
    expect(reasonFragment("rule:pork")).toBe("contains pork, which your rules exclude.");
    expect(reasonFragment("rule:contains_dairy")).toBe("contains dairy, which your rules exclude.");
    expect(reasonFragment("rule:custom_ingredient:egg")).toBe("matches your rule against egg.");
    expect(reasonLabel("rule:custom_ingredient:egg")).toBe("Your rule: egg");
  });

  it("keeps the allergen, category and Avoid wording", () => {
    expect(reasonFragment("allergen:tree_nut")).toBe("has tree nut, which your rules exclude.");
    expect(reasonFragment("category:onion_garlic")).toBe("is in a category your rules exclude (onion garlic).");
    expect(reasonFragment("avoid_list")).toBe("is on your Avoid list.");
    expect(reasonLabel("allergen:peanut")).toBe("Contains peanut");
  });

  it("never shows an unknown code", () => {
    for (const code of ["facet:new_thing", "rule:new_thing", "weird", undefined]) {
      expect(reasonFragment(code)).not.toMatch(/:|_/);
      expect(reasonLabel(code)).toBe("Off your rules");
    }
    expect(reasonLabel("weird", "Off-plan")).toBe("Off-plan");
  });
});
