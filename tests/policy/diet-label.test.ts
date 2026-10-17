/**
 * W104: the diet-label ingredient parser (lib/policy/diet-label.ts). Pinned cases for what reads as
 * plant-only, the Option A cases that must stay unverified, and the switch that keeps it off until
 * the Sol review passes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePolicy, EMPTY_PROFILE, type PolicyEvidence } from "@/lib/policy/constraints";
import { dietFacetOutcome, type DietEvidence } from "@/lib/policy/diet-evidence";
import {
  DIET_LABEL_CLEARANCE_DEFAULT, dietLabelClearanceEnabled, dietLabelRulesOut, isPlantOnlyStatement,
  LABEL_CLEARABLE_FACETS, overrideDietLabelClearanceForReport, parseIngredientStatement,
} from "@/lib/policy/diet-label";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";

const label = (text: string): DietEvidence => ({ ingredientsText: text, ingredientsTextIsLabel: true });

function verdict(foodName: string, flags: PolicyPreferenceFlag[], extra: Partial<PolicyEvidence> = {}) {
  return evaluatePolicy(EMPTY_PROFILE, {
    foodRefId: "f1", allergenTags: [], category: [], onEatsList: true, onAvoidList: false,
    foodName, preferenceFlags: flags, ...extra,
  }).verdict;
}

afterEach(() => overrideDietLabelClearanceForReport(DIET_LABEL_CLEARANCE_DEFAULT));

describe("plant-only statements", () => {
  it.each([
    "Black beans, water, salt.",
    "Ingredients: Prepared chickpeas, water, salt, disodium EDTA (to promote color retention).",
    "Tomatoes, tomato juice, citric acid, calcium chloride (firming agent).",
    "Enriched wheat flour (wheat flour, niacin, reduced iron, thiamine mononitrate, riboflavin, folic acid), water, yeast, salt.",
    "Water, black beans, salt. Contains: soy.",
    "Water, black beans, salt. Produced in a facility that also processes milk and eggs.",
    "Vegetable oil (canola and/or sunflower oil), potatoes, sea salt.",
    "Organic cane sugar, water, salt.",
    "Oyster mushrooms, water, salt.",
    "Rice, water, salt and pepper.",
    "Water, kidney beans, contains 2% or less of: salt, onion powder, garlic powder.",
    "Pinto beans, water, less than 0.5% of: salt.",
  ])("%s", (text) => {
    expect(isPlantOnlyStatement(text)).toBe(true);
  });
});

describe("statements that stay unverified", () => {
  it.each([
    // The W2c Option A cases: a generic head never qualifies, whatever it carries.
    "Water, vegetable glycerin, salt.",
    "Water, shortening (palm), salt.",
    "Water, corn starch and oil, salt.",
    // Bone-char sugar, an unnamed flavour, and animal-sourced additives.
    "Sugar, water, salt.",
    "Rice, natural flavor, salt.",
    "Water, beans, mono- and diglycerides.",
    "Water, beans, lactic acid.",
    "Rice, beef, salt.",
    "Rice, water, gelatin.",
    // Shape: no final period, one item, unbalanced, an unknown trailing sentence, a cropped clause.
    "Water, beans, salt",
    "Black beans.",
    "Water, beans (water, salt, salt.",
    "Water, beans, salt. Made with love.",
    "Water, beans, salt. Contains 2% or less of: natural flavor.",
    "Water, beans, salt. Contains:",
    "Water, beans, salt. May contain natural flavor.",
    "Water, beans, salt (contains one or more of the following: natural flavor).",
    // Words that only look like a plant, and the edge words the W2c review pinned.
    "Eggplant, water, salt.",
    "Beef tomatoes, water, salt.",
    "",
  ])("%j", (text) => {
    expect(isPlantOnlyStatement(text)).toBe(false);
  });

  it("parses nested lists apart from the purpose notes", () => {
    expect(parseIngredientStatement("Water, beans (pinto beans, water), salt (to preserve freshness)."))
      .toEqual([{ name: "water", parts: [] },
        { name: "beans", parts: [{ name: "pinto beans", parts: [] }, { name: "water", parts: [] }] },
        { name: "salt", parts: [] }]);
  });
});

describe("dietLabelRulesOut", () => {
  it("only the six animal facets, and only from the label's own text", () => {
    expect([...LABEL_CLEARABLE_FACETS].sort()).toEqual(
      ["animal_product", "beef", "fish_seafood", "meat", "pork", "shellfish"]);
    expect(dietLabelRulesOut("alcohol", label("Water, beans, salt."))).toBe(false);
    expect(dietLabelRulesOut("contains_dairy", label("Water, beans, salt."))).toBe(false);
    expect(dietLabelRulesOut("meat", { ingredientsText: "Water, beans, salt.", ingredientsTextIsLabel: false }))
      .toBe(false);
    expect(dietLabelRulesOut("meat", label("Water, beans, salt."))).toBe(true);
  });
});

describe("wiring into the diet facets", () => {
  it("ships off until Sol reviews it: a plant-only label still leaves an animal facet unknown", () => {
    expect(DIET_LABEL_CLEARANCE_DEFAULT).toBe(false);
    expect(dietLabelClearanceEnabled()).toBe(false);
    expect(dietFacetOutcome("animal_product", { foodName: "Black beans, canned", ...label("Black beans, water, salt.") }))
      .toBe("unknown");
    expect(verdict("Canned black beans", ["vegan"], label("Black beans, water, salt."))).toBe("unverified");
  });

  describe("turned on", () => {
    it("clears an animal facet the label rules out, and recovers the food", () => {
      overrideDietLabelClearanceForReport(true);
      for (const facet of LABEL_CLEARABLE_FACETS) {
        expect(dietFacetOutcome(facet, { foodName: "Canned black beans", ...label("Black beans, water, salt.") }),
          facet).toBe("absent");
      }
      expect(verdict("Canned black beans", ["vegan"], label("Black beans, water, salt."))).toBe("allowed");
      expect(verdict("Canned black beans", ["vegetarian"], label("Black beans, water, salt."))).toBe("allowed");
    });

    it("still blocks what the food's own words name, before the label is read", () => {
      overrideDietLabelClearanceForReport(true);
      expect(dietFacetOutcome("meat", { foodName: "Chicken-style soup", ...label("Water, rice, salt.") }))
        .toBe("present");
      expect(verdict("Gummies", ["vegetarian"], label("Sugar, gelatin, water."))).toBe("blocked");
      expect(verdict("Snack", ["vegan"], label("Rice, sugar, honey, salt."))).toBe("blocked");
    });

    it("keeps the Option A cases unverified", () => {
      overrideDietLabelClearanceForReport(true);
      for (const text of ["Water, vegetable glycerin, salt.", "Water, shortening (palm), salt.",
        "Water, corn starch and oil, salt."]) {
        expect(verdict("Snack", ["vegan"], label(text)), text).toBe("unverified");
      }
    });

    it("never clears a facet a held allergen row backs", () => {
      overrideDietLabelClearanceForReport(true);
      const heldFish: DietEvidence = { allergenEvidence: { fish: { level: "listed", source: "jev",
        labelComplete: false, held: true } } } as unknown as DietEvidence;
      expect(dietFacetOutcome("fish_seafood", { foodName: "Broth", ...label("Water, onion, salt."), ...heldFish }))
        .toBe("unknown");
    });

    it("leaves alcohol on its own label rule", () => {
      overrideDietLabelClearanceForReport(true);
      expect(dietFacetOutcome("alcohol", { foodName: "x", ...label("Water, soy sauce, salt.") })).toBe("unknown");
    });
  });

  it("no app path turns it on: only the offline count and tests call the override", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(path, "utf8").includes("overrideDietLabelClearanceForReport(")) {
          callers.push(path);
        }
      }
    };
    for (const root of ["app", "lib", "components"]) walk(root);
    expect(callers).toEqual([join("lib", "policy", "diet-label.ts")]);
  });
});
