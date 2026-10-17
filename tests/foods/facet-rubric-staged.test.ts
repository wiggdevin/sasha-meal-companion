/**
 * W106: the map's §5.4 rubric fixes are staged as rubric v2 and not asked yet. The warm job keeps
 * asking RUBRIC_VERSION 1 wording until the billed calibration run regenerates the threshold bands.
 */
import { describe, expect, it } from "vitest";
import {
  facetQuestions, RUBRIC_VERSION, STAGED_RUBRIC_FIXES, STAGED_RUBRIC_VERSION,
} from "@/lib/foods/facet-questions";
import { FACET_THRESHOLD_RUBRIC_VERSION } from "@/lib/foods/facet-thresholds";
import { FACETS } from "@/lib/foods/facet-vocabulary";

const text = (facet: keyof typeof STAGED_RUBRIC_FIXES) => {
  const rubric = STAGED_RUBRIC_FIXES[facet]!;
  return `${rubric.instructions} ${rubric.criteria.true} ${rubric.criteria.false}`.toLowerCase();
};

describe("staged rubric v2 (W106)", () => {
  it("is staged, not live: the asked version still matches the threshold bands", () => {
    expect(STAGED_RUBRIC_VERSION).toBe(RUBRIC_VERSION + 1);
    expect(RUBRIC_VERSION).toBe(FACET_THRESHOLD_RUBRIC_VERSION);
    const food = { name: "Oat bar" };
    expect(facetQuestions(food, FACETS)).not.toEqual(facetQuestions(food, FACETS, "staged"));
    for (const facet of FACETS) {
      if (facet in STAGED_RUBRIC_FIXES) continue;
      expect(facetQuestions(food, [facet], "staged"), facet).toEqual(facetQuestions(food, [facet]));
    }
  });

  it("carries each §5.4 fix", () => {
    expect(text("contains_gluten")).toMatch(/oats not labelled gluten-free/);
    expect(text("contains_gluten")).toMatch(/brewer's yeast/);
    expect(text("contains_gluten")).toMatch(/malt/);
    expect(text("contains_dairy")).toMatch(/lactose-free/);
    expect(text("contains_dairy")).toMatch(/goat/);
    expect(text("contains_dairy")).toMatch(/sheep/);
    expect(text("contains_egg")).toMatch(/duck/);
    expect(text("contains_egg")).toMatch(/quail/);
    expect(text("contains_tree_nut")).toMatch(/coconut alone is false/);
    expect(text("contains_tree_nut")).toMatch(/pine nut/);
    expect(text("alcohol")).toMatch(/non-alcoholic/);
    expect(text("alcohol")).toMatch(/vanilla extract/);
  });

  it("touches only the facets the map fixes", () => {
    expect(Object.keys(STAGED_RUBRIC_FIXES).sort())
      .toEqual(["alcohol", "contains_dairy", "contains_egg", "contains_gluten", "contains_tree_nut"]);
  });
});
