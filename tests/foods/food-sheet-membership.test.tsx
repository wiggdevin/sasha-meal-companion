import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FoodSheet, { foodSheetAction } from "@/components/FoodSheet";
import { foodMembershipError, foodMembershipNotice } from "@/components/MyFoods";
import type { Food } from "@/lib/foods";
import { FoodMembershipSaveError } from "@/lib/foods/prefs-client";

const NOOP = () => {};
const base: Food = { id: "chicken", name: "Chicken breast", role: "protein", unit: "oz",
  perUnit: { protein: 8.8, carbs: 0, fat: 1 }, status: "eats",
  updatedAt: "2026-09-20T00:00:00.000Z" };

function render(status: Food["status"]): string {
  return renderToStaticMarkup(
    <FoodSheet food={{ ...base, status }} onSetStatus={NOOP} onSetNote={NOOP} onClose={NOOP} />,
  );
}

describe("FoodSheet membership actions", () => {
  it.each([
    ["eats", "avoid", "Add to Avoid"],
    ["avoid", "neutral", "Remove from Avoid"],
    ["neutral", "eats", "Add to Eats"],
  ] as const)("maps %s to %s and labels the action %s", (status, next, label) => {
    expect(foodSheetAction(status)).toEqual({ next, label });
    expect(render(status)).toContain(label);
  });

  it("shows the membership truncated warning only for a bounded acknowledgement", () => {
    expect(foodMembershipNotice({ truncated: true }))
      .toBe("Marked; some duplicate catalog rows were skipped");
    expect(foodMembershipNotice({ truncated: false })).toBeNull();
  });

  it("shows the typed sign-in error message instead of the generic save error", () => {
    expect(foodMembershipError(new FoodMembershipSaveError("sign in to save")))
      .toBe("sign in to save");
    expect(foodMembershipError(new Error("raw failure"))).toBe("Could not save — try again");
  });

  it("shows rounded serving macros without floating-point noise", () => {
    const banana: Food = { ...base, name: "Banana", role: "carb", unit: "whole",
      perUnit: { protein: 1.8880000000000001, carbs: 39.176, fat: 0.47200000000000003 } };
    const markup = renderToStaticMarkup(
      <FoodSheet food={banana} onSetStatus={NOOP} onSetNote={NOOP} onClose={NOOP} />,
    );
    // Stated per 100 g, the label's basis: the curated banana starter weighs 118 g.
    expect(markup).toContain("143 kcal / 100 g · 2g protein · 33g carbs · 0g fat");
    expect(markup).not.toContain("1.8880000000000001");
    expect(banana.perUnit.protein).toBe(1.8880000000000001);
  });
});
