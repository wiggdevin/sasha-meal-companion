/** U8: the meal card's ingredient stepper steps by a food's portion when one is known. */
import { describe, expect, it } from "vitest";
import { ingredientQtyLabel, ingredientStep, stepIngredientQty } from "@/lib/plan/ingredient-step";

const grams = (qty: number) => ({ unit: "g" as const, qty });
const TBSP = { label: "1 tbsp", grams: 14 };

describe("ingredientStep", () => {
  it("steps grams by the portion, else 25 g; a cup by a quarter; a count by one", () => {
    expect(ingredientStep(grams(28), TBSP)).toBe(14);
    expect(ingredientStep(grams(28), null)).toBe(25);
    expect(ingredientStep({ unit: "cup" })).toBe(0.25);
    expect(ingredientStep({ unit: "whole" }, TBSP)).toBe(1);
  });
});

describe("stepIngredientQty", () => {
  it("snaps to whole portions going up and down", () => {
    expect(stepIngredientQty(grams(28), 1, TBSP)).toBe(42);
    expect(stepIngredientQty(grams(28), -1, TBSP)).toBe(14);
    expect(stepIngredientQty(grams(100), 1, TBSP)).toBe(112);
    expect(stepIngredientQty(grams(100), -1, TBSP)).toBe(98);
  });

  it("never goes below one portion, and leaves a line already under one portion alone going down", () => {
    expect(stepIngredientQty(grams(14), -1, TBSP)).toBe(14);
    expect(stepIngredientQty(grams(5), -1, TBSP)).toBe(5);
    expect(stepIngredientQty(grams(5), 1, TBSP)).toBe(14);
  });

  it("keeps the unit rule without a portion", () => {
    expect(stepIngredientQty(grams(100), 1, null)).toBe(125);
    expect(stepIngredientQty(grams(10), -1, null)).toBe(1);
    expect(stepIngredientQty({ unit: "cup", qty: 0.25 }, -1)).toBe(0.25);
    expect(stepIngredientQty({ unit: "whole", qty: 2 }, 1, TBSP)).toBe(3);
  });
});

describe("ingredientQtyLabel", () => {
  it("says a clean number of short portions with the weight", () => {
    expect(ingredientQtyLabel(grams(28), TBSP, "28 g")).toBe("2 tbsp · 28 g");
    expect(ingredientQtyLabel(grams(7), TBSP, "7 g")).toBe("½ tbsp · 7 g");
    expect(ingredientQtyLabel(grams(27), { label: "1 tablespoon", grams: 13.5 }, "27 g")).toBe("2 tbsp · 27 g");
  });

  it("falls back to the weight for an uneven amount or a long portion name", () => {
    expect(ingredientQtyLabel(grams(30), TBSP, "30 g")).toBe("30 g");
    expect(ingredientQtyLabel(grams(172), { label: "0.5 breast, bone and skin removed", grams: 86 }, "172 g"))
      .toBe("1 breast · 172 g");
    expect(ingredientQtyLabel(grams(100), { label: "1 unit (yield from 1 lb)", grams: 52 }, "100 g")).toBe("100 g");
    expect(ingredientQtyLabel(grams(100), null, "100 g")).toBe("100 g");
    expect(ingredientQtyLabel({ unit: "cup", qty: 0.5 }, TBSP, "½ cup")).toBe("½ cup");
  });
});
