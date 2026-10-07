import { describe, expect, it } from "vitest";
import { FACET_THRESHOLDS } from "@/lib/foods/facet-thresholds";
import {
  FACET_RULES,
  facetOutcome,
} from "@/lib/policy/facet-rules";
import { PREFERENCE_FLAGS } from "@/lib/profile/onboarding-state";

const APP_RULES = {
  vegetarian: ["meat", "fish_seafood", "shellfish"],
  vegan: ["animal_product", "meat", "fish_seafood", "shellfish"],
  pescatarian: ["meat", "pork", "beef"],
  no_pork: ["pork"],
  no_beef: ["beef"],
  no_shellfish: ["shellfish"],
  no_eggs: ["contains_egg"],
  no_soy: ["contains_soy"],
  no_peanuts: ["contains_peanut"],
  low_fodmap: ["onion_garlic", "beans"],
  halal: ["pork", "alcohol"],
  kosher: ["pork", "shellfish"],
} as const satisfies Record<string, readonly string[]>;

describe("policy facet rules", () => {
  it("maps every app preference to the PRD facets", () => {
    expect(Object.fromEntries(PREFERENCE_FLAGS.map((flag) => [
      flag, FACET_RULES[flag].map((rule) => rule.facet),
    ]))).toEqual(APP_RULES);
  });

  it("exposes only the twelve app preference flags", () => {
    expect(Object.keys(FACET_RULES)).toEqual(PREFERENCE_FLAGS);
  });

  it.each(["mark", "exclude"] as const)(
    "uses the frozen per-action threshold band for %s outcomes",
    (action) => {
      const band = FACET_THRESHOLDS.meat[action];
      expect(facetOutcome("meat", band.present, action)).toBe("present");
      expect(facetOutcome("meat", band.absent, action)).toBe("absent");
      expect(facetOutcome("meat", (band.present + band.absent) / 2, action)).toBe("unknown");
      expect(facetOutcome("meat", undefined, action)).toBe("unknown");
    },
  );
});
