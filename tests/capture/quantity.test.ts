import { describe, expect, it } from "vitest";
import { gramsFor, matchPortion, parseAmount } from "@/lib/capture/quantity";

const PORTIONS = [
  { id: 5, description: "1 cup, cooked", gramWeight: 158 },
  { id: 6, description: "1 slice", gramWeight: 28 },
  { id: 7, description: "1 whole", gramWeight: 50 },
];

describe("parseAmount", () => {
  it.each([
    ["two eggs", 2, "whole"],
    ["half an avocado", 0.5, "whole"],
    ["1/2 cup of rice", 0.5, "cup"],
    ["a rice cake", 1, "whole"],
    ["150 g chicken", 150, "g"],
    ["3 oz salmon", 3, "oz"],
    ["1 tbsp olive oil", 1, "tbsp"],
    ["2 slices of bacon", 2, "slice"],
    ["quarter of a melon", 0.25, "whole"],
  ])("reads %s as %s %s", (text, qty, unit) => {
    expect(parseAmount(text)).toEqual({ qty, unit });
  });

  it.each([["a handful of olives"], ["some rice"], ["a scoop of protein"], ["chicken"]])(
    "refuses the vague amount in %s", (text) => expect(parseAmount(text)).toBeNull()
  );
});

describe("matchPortion", () => {
  it("finds the portion row whose description names the unit", () => {
    expect(matchPortion("cup", PORTIONS)?.id).toBe(5);
    expect(matchPortion("slice", PORTIONS)?.id).toBe(6);
  });
  it("returns null when no portion names it", () => {
    expect(matchPortion("tbsp", PORTIONS)).toBeNull();
  });
});

describe("gramsFor", () => {
  it("passes grams through and converts ounces", () => {
    expect(gramsFor(150, "g", [], {})).toBe(150);
    expect(gramsFor(3, "oz", [], {})).toBeCloseTo(85.05, 2);
  });
  it("multiplies the matching portion's gram weight", () => {
    expect(gramsFor(2, "slice", PORTIONS, {})).toBe(56);
    expect(gramsFor(0.5, "cup", PORTIONS, {})).toBe(79);
  });
  it("returns null for a volume unit with no portion row, rather than guessing a density", () => {
    expect(gramsFor(1, "tbsp", PORTIONS, {})).toBeNull();
  });
  it("falls back to 100 g for a whole with no portion row only when per100g is known", () => {
    expect(gramsFor(1, "whole", [], { energy_kcal: 52 })).toBe(100);
    expect(gramsFor(1, "whole", [], {})).toBeNull();
  });
});
