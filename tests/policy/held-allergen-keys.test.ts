/** W2a hand-off: the food sheet learns which allergens are held for review on a revision. */
import { describe, expect, it } from "vitest";
import { heldAllergenKeys } from "@/lib/policy/held-allergens";

describe("heldAllergenKeys", () => {
  it("lists only held keys, sorted", () => {
    expect(heldAllergenKeys({
      soy: { level: "listed", labelComplete: false, held: true },
      dairy: { level: "listed", labelComplete: true },
      egg: { level: "not_listed", labelComplete: true },
      peanut: { level: "listed", labelComplete: false, held: true },
    })).toEqual(["peanut", "soy"]);
  });

  it("is empty when nothing is held", () => {
    expect(heldAllergenKeys({})).toEqual([]);
    expect(heldAllergenKeys({ dairy: { level: "no_evidence", labelComplete: false } })).toEqual([]);
  });
});
