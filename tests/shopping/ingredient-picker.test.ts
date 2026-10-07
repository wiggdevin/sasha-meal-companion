import { describe, expect, it } from "vitest";
import { FOOD_DB } from "@/lib/food-db";
import { favoriteIngredientOption } from "@/components/ShoppingIngredientPicker";
import { realCalendarDate } from "@/components/ShoppingControls";

describe("shopping ingredient choices", () => {
  it("maps a named food favorite to its canonical bundled food, not to confirmed stock", () => {
    const food = FOOD_DB[0];
    expect(favoriteIngredientOption({ kind: "food", name: food.name,
      foodRefId: "11111111-1111-4111-8111-111111111111" })).toMatchObject({
        source: "favorite", identity: { foodDbId: food.id, foodRefId: null,
          purchaseState: "raw", variantKey: "raw" },
      });
    expect(favoriteIngredientOption({ kind: "recipe", name: food.name })).toBeNull();
  });
  it("rejects normalized impossible dates before preview", () => {
    expect(realCalendarDate("2026-02-30")).toBe(false);
    expect(realCalendarDate("2026-09-27")).toBe(true);
  });
});
