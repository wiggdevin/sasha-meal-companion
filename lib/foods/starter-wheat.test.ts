/**
 * W014 (audit 2026-10-10 A041): wheat and gluten are one concern for starters. The bread starters
 * declared only "gluten", and "wheat" (a FALCPA major allergen) has no alias to it, so an account
 * that avoids wheat was still offered white and whole-wheat bread — and the fresh-rules recheck
 * before the write let them through too.
 */
import { describe, expect, it } from "vitest";
import { STARTERS, starterChoices, starterExcludedByCurrentRules } from "./starter";

const rules = { avoid_allergens: [] as string[], avoid_food_ref_ids: [], banned_categories: [],
  conditions: [], notes: null };
const BREADS = ["white-bread", "whole-wheat-bread"];
const offered = (avoid: string[]) => starterChoices([], { ...rules, avoid_allergens: avoid })
  .map((item) => item.id).filter((id) => BREADS.includes(id));

describe("starters treat wheat and gluten as one concern", () => {
  it("keeps bread out for a wheat avoid, a gluten avoid, or both", () => {
    expect(offered([])).toEqual(BREADS);
    expect(offered(["wheat"])).toEqual([]);
    expect(offered(["Wheat "])).toEqual([]);
    expect(offered(["gluten"])).toEqual([]);
  });

  it("the just-before-write recheck excludes bread for a wheat avoid", () => {
    for (const id of BREADS) {
      const bread = STARTERS.find((item) => item.id === id)!;
      expect(starterExcludedByCurrentRules(bread, { ...rules, avoid_allergens: ["wheat"] }, []), id).toBe(true);
    }
  });

  it("leaves a wheat-free starter alone", () => {
    expect(starterChoices([], { ...rules, avoid_allergens: ["wheat"] })
      .some((item) => item.id === "corn-tortilla")).toBe(true);
  });
});
